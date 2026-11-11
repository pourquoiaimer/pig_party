/**
 * pig_party 連線伺服器（v0：大廳同步）
 *
 * 定位：**房間登記 + 狀態轉發**，不在伺服器跑遊戲邏輯。
 *   大廳只需要「看到對方在哪、朝哪、穿什麼」，每個客戶端只送自己那隻豬的狀態，
 *   伺服器原封不動轉給對手 —— 這是最省 CPU/流量、也最不會出錯的形狀。
 *   小遊戲之後要「伺服器權威」時，再往上加 authority 層，不改這裡的房間機制。
 *
 * 安全邊界：
 *   · 只綁 127.0.0.1（外部一律經 Caddy 反向代理，TLS 在 Caddy 那層）
 *   · 單則訊息上限 4 KB、單連線每秒 90 則（正常 30Hz 只用 30）
 *   · 記憶體硬上限由 systemd MemoryMax=160M 控制，這裡不自行長大
 *
 * 協定（JSON 文字，先求好讀；之後要省流量再換二進位）：
 *   C→S  {t:'create', name}          建立房間
 *   S→C  {t:'room', code, role:'host', peer:null}
 *   C→S  {t:'join', code, name}      加入房間
 *   S→C  {t:'room', code, role:'guest', peer:'<host 名字>'}
 *   S→H  {t:'peer', on:true, role:'guest', name}
 *   C→S  {t:'s', d:{...}}            自己的狀態，會被轉給對手
 *   S→C  {t:'s', d:{...}}            對手的狀態
 *   S→C  {t:'peer', on:false}        對手離線
 *   C→S  {t:'bye'}                   主動離開
 *   C→S  {t:'ping'} / S→C {t:'pong'} （除錯用；連線存活靠 WebSocket ping frame）
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8890);
const HOST = process.env.HOST || '127.0.0.1';

const MAX_MSG = 4096;                 // 單則訊息上限（bytes）
const MSG_PER_SEC = 90;               // 單連線每秒訊息上限
const ROOM_TTL_MS = 2 * 60 * 60e3;    // 房間最長存活 2 小時
const IDLE_MS = 45e3;                 // 沒有 ping/pong 反應就切斷
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去 I/O/0/1/B 等易混淆字

const rooms = new Map();              // code -> { code, host, guest, createdAt, lastActive }

/* ---------- 小工具 ---------- */
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(s)) return s;
  }
  return null;
}

function send(c, obj) {
  if (!c || c.ws.readyState !== 1) return;
  const s = JSON.stringify(obj);
  if (s.length > MAX_MSG * 4) return;   // 保護：不轉發異常大的東西
  try { c.ws.send(s); } catch (e) { /* 客戶端已斷，close 事件會處理 */ }
}

function peerOf(c) {
  const r = c.room;
  if (!r) return null;
  return c.role === 'host' ? r.guest : r.host;
}

function dropFromRoom(c, reason) {
  const r = c.room;
  if (!r) return;
  const other = peerOf(c);
  if (c.role === 'host') r.host = null; else r.guest = null;
  c.room = null;
  c.role = null;
  if (other) {
    send(other, { t: 'peer', on: false, reason: reason || 'left' });
    if (other.room && !other.room.host && !other.room.guest) rooms.delete(other.room.code);
  } else {
    rooms.delete(r.code);
  }
  log('room', r.code, 'peer left ->', reason || 'left');
}

/* ---------- HTTP（健康檢查 + 給人看的說明） ---------- */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') {
    const m = process.memoryUsage();
    const body = JSON.stringify({
      ok: true,
      service: 'pig-party-relay',
      rooms: rooms.size,
      uptimeSec: Math.round(process.uptime()),
      rssMB: +(m.rss / 1048576).toFixed(1),
      node: process.version,
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('pig_party relay ok — 這是 WebSocket 伺服器，不是網頁。\n健康檢查：/health\n');
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

wss.on('connection', (ws, req) => {
  const c = {
    ws,
    role: null,
    room: null,
    name: '',
    alive: true,
    msgWindowStart: now(),
    msgCount: 0,
  };
  ws.on('pong', () => { c.alive = true; });

  ws.on('message', (raw) => {
    // 速率限制（滑動 1 秒窗）
    const t = now();
    if (t - c.msgWindowStart >= 1000) { c.msgWindowStart = t; c.msgCount = 0; }
    if (++c.msgCount > MSG_PER_SEC) {
      log('rate limit ->', req.socket.remoteAddress);
      try { ws.close(1008, 'rate limit'); } catch (e) {}
      return;
    }

    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'create': {
        if (c.room) return send(c, { t: 'err', msg: 'already in room' });
        const code = newCode();
        if (!code) return send(c, { t: 'err', msg: 'server full' });
        c.role = 'host';
        c.name = String(m.name || '').slice(0, 12);
        c.room = { code, host: c, guest: null, createdAt: now(), lastActive: now() };
        rooms.set(code, c.room);
        send(c, { t: 'room', code, role: 'host', peer: null });
        log('room', code, 'created by', c.name);
        break;
      }
      case 'join': {
        if (c.room) return send(c, { t: 'err', msg: 'already in room' });
        const code = String(m.code || '').toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) return send(c, { t: 'err', msg: 'no such room', code });
        if (r.guest) return send(c, { t: 'err', msg: 'room full', code });
        c.role = 'guest';
        c.name = String(m.name || '').slice(0, 12);
        c.room = r;
        r.guest = c;
        r.lastActive = now();
        send(c, { t: 'room', code, role: 'guest', peer: r.host ? r.host.name : null });
        send(r.host, { t: 'peer', on: true, role: 'guest', name: c.name });
        log('room', code, 'joined by', c.name);
        break;
      }
      case 's': {
        if (!c.room) return;
        c.room.lastActive = now();
        const other = peerOf(c);
        if (other) send(other, { t: 's', d: m.d });
        break;
      }
      case 'ping':
        send(c, { t: 'pong', ts: now() });
        break;
      case 'bye':
        dropFromRoom(c, 'bye');
        try { ws.close(1000, 'bye'); } catch (e) {}
        break;
      default:
        send(c, { t: 'err', msg: 'unknown type: ' + m.t });
    }
  });

  ws.on('close', () => dropFromRoom(c, 'disconnect'));
  ws.on('error', () => dropFromRoom(c, 'error'));
});

/* 每 30 秒：踢掉沒反應的連線 + 清掉過期房間 */
const sweeper = setInterval(() => {
  for (const c of wss.clients) {
    const cc = c;
    if (cc.alive === false) { try { cc.terminate(); } catch (e) {} continue; }
    cc.alive = false;
    try { cc.ping(); } catch (e) {}
  }
  const t = now();
  for (const [code, r] of rooms) {
    if (t - r.createdAt > ROOM_TTL_MS || (t - r.lastActive > ROOM_TTL_MS)) {
      rooms.delete(code);
      log('room', code, 'expired');
    }
  }
  // 沒人要的房間也清掉（host 走了但沒觸發 close 的殘留）
  for (const [code, r] of rooms) {
    if (!r.host && !r.guest) { rooms.delete(code); log('room', code, 'empty'); }
  }
}, 30e3);
sweeper.unref?.();

server.listen(PORT, HOST, () => {
  log(`pig_party relay listening on ws://${HOST}:${PORT}  (health: /health)`);
});

/* 收到終止訊號時乾淨關閉，避免 systemd 重啟時卡住 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('shutting down on', sig);
    for (const c of wss.clients) { try { c.close(1001, 'server shutdown'); } catch (e) {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  });
}

/* 最後一道保險：任何未捕捉例外都不要讓整個服務消失（systemd 也會重啟，但少一次抖動） */
process.on('uncaughtException', (e) => log('uncaughtException', e && e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.message));
