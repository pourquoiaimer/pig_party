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
 *
 *   ── 排球（伺服器權威，05B）──────────────────────────────
 *   C→S  {t:'start', game:'volley'}  只有 host 能發 → 建立比賽
 *   S→C  {t:'gstart', game:'volley'} 兩邊都收到，前端據此進小遊戲
 *   C→S  {t:'gi', i:{l,r,u}}         自己的輸入（只作用在自己的 index）
 *   S→C  {t:'gs', k, s, ev}          30Hz 狀態快照
 *   S→C  {t:'gend', win, reason?}    比賽結束
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadVolleyLogic, volleyInfo, newMatch, stepMatch, setInput, snapshot, TICK_S,
         loadOxLogic, oxInfo, newOxMatch, oxCommand, oxSnapshot,
         loadMemoryLogic, memInfo, newMemoryMatch, memCommand, memTickMatch, memSnapshot,
         load2048Logic, info2048, newMatch2048, command2048, snapshot2048 } from './game-host.mjs';

const PORT = Number(process.env.PORT || 8890);
const HOST = process.env.HOST || '127.0.0.1';

const MAX_MSG = 4096;                 // 一般訊息上限（bytes）
const SIG_MAX = 8 * 1024;             // 語音 signaling（SDP）上限：比一般訊息寬，但仍要擋超大
const MAX_PAYLOAD = 16 * 1024;        // WebSocket 框架層硬上限（要 > SIG_MAX，否則 SDP 會被底層直接切線）
const MSG_PER_SEC = 90;               // 單連線每秒訊息上限
const ROOM_TTL_MS = 2 * 60 * 60e3;    // 房間最長存活 2 小時
const IDLE_MS = 45e3;                 // 沒有 ping/pong 反應就切斷
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去 I/O/0/1/B 等易混淆字

const rooms = new Map();              // code -> { code, host, guest, createdAt, lastActive }

/* ---------- 小工具 ---------- */
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- 排球邏輯（05B：伺服器權威） ----------
   載入失敗只停用排球，大廳中繼照常運作（不要因為一個小遊戲讓整個服務死掉）。 */
const VOLLEY = loadVolleyLogic();
if (VOLLEY.ok) log(`volley: 已載入（${VOLLEY.source}，${VOLLEY.lines} 行，${VOLLEY.winPts} 分制）`);
else           log(`volley: 未載入 —— ${VOLLEY.reason}（大廳中繼照常）`);
const OX = loadOxLogic();
if (OX.ok) log(`ox: 已載入（${OX.source}，${OX.lines} 行）`);
else       log(`ox: 未載入 —— ${OX.reason}（其他功能照常）`);
const MEM = loadMemoryLogic();
if (MEM.ok) log(`memory: 已載入（${MEM.source}，${MEM.lines} 行）`);
else        log(`memory: 未載入 —— ${MEM.reason}（其他功能照常）`);
const E2048 = load2048Logic();
if (E2048.ok) log(`2048: 已載入（${E2048.source}，${E2048.lines} 行）`);
else          log(`2048: 未載入 —— ${E2048.reason}（其他功能照常）`);

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

/** 房間裡兩個人都送（不存在的那一邊自動跳過） */
function sendBoth(r, obj) {
  if (!r) return;
  if (r.host) send(r.host, obj);
  if (r.guest) send(r.guest, obj);
}

/** 圈叉廣播：狀態有變、或 500ms 心跳時呼叫。兩邊收到的是同一份物件 → 內容保證相同 */
function broadcastOx(r, ev) {
  const m = r && r.match;
  if (!m || m.game !== 'ox') return;
  m.k++;
  m.lastBc = now();
  const pkt = oxSnapshot(m, ev);
  m.lastBytes = Buffer.byteLength(JSON.stringify(pkt));
  sendBoth(r, pkt);
  if (m.S.over && !m.overSent) {
    m.overSent = true;
    sendBoth(r, { t: 'gend', win: m.S.winner });
    log('room', r.code, 'ox over, win', m.S.winner);
  }
}

/** 翻牌廣播：翻牌／消失／換手 → 立即；其餘時間 1Hz 心跳 */
function broadcastMem(r, ev) {
  const m = r && r.match;
  if (!m || m.game !== 'memory') return;
  m.k++;
  m.lastBc = now();
  const pkt = memSnapshot(m, ev);
  m.lastBytes = Buffer.byteLength(JSON.stringify(pkt));
  sendBoth(r, pkt);
  if (m.S.over && !m.overSent) {
    m.overSent = true;
    sendBoth(r, { t: 'gend', win: m.S.winner });
    log('room', r.code, 'memory over, win', m.S.winner);
  }
}

/** 2048 廣播：有動作 → 立即；其餘 1Hz 心跳。兩人各自盤 */
function broadcast2048(r, ev) {
  const m = r && r.match;
  if (!m || m.game !== '2048') return;
  m.k++;
  m.lastBc = now();
  const pkt = snapshot2048(m, ev);
  m.lastBytes = Buffer.byteLength(JSON.stringify(pkt));
  sendBoth(r, pkt);
  if (m.over && !m.overSent) {
    m.overSent = true;
    const s0 = m.g[0].score | 0, s1 = m.g[1].score | 0;
    m.winner = s0 === s1 ? -1 : (s0 > s1 ? 0 : 1);
    sendBoth(r, { t: 'gend', win: m.winner });
    log('room', r.code, '2048 over, win', m.winner, s0, s1);
  }
}

function dropFromRoom(c, reason) {
  const r = c.room;
  if (!r) return;
  const other = peerOf(c);
  /* 比賽中有人離開 → 中止比賽並通知留下來的那一邊（房間本身照下面的原流程處理） */
  if (r.match) {
    const w = r.match.S && r.match.S.over ? r.match.S.winner : -1;
    r.match = null;
    if (other) send(other, { t: 'gend', win: w, reason: reason || 'peer left' });
    log('room', r.code, 'match aborted ->', reason || 'left');
  }
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
    let matches = 0;
    for (const r of rooms.values()) if (r.match) matches++;
    const vi = volleyInfo();
    const body = JSON.stringify({
      ok: true,
      service: 'pig-party-relay',
      rooms: rooms.size,
      matches,
      volley: vi.ok
        ? { ok: true, source: vi.source, lines: vi.lines, winPts: vi.winPts }
        : { ok: false, reason: vi.reason },
      ox: (() => { const xi = oxInfo(); return xi.ok
        ? { ok: true, source: xi.source, lines: xi.lines }
        : { ok: false, reason: xi.reason }; })(),
      memory: (() => { const mi = memInfo(); return mi.ok
        ? { ok: true, source: mi.source, lines: mi.lines }
        : { ok: false, reason: mi.reason }; })(),
      '2048': (() => { const ei = info2048(); return ei.ok
        ? { ok: true, source: ei.source, lines: ei.lines }
        : { ok: false, reason: ei.reason }; })(),
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
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

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
  /* ⚠️ alive 要掛在 **ws 實例**上：下面的 sweeper 走的是 wss.clients（那是 ws 實例），
     不是這裡的 context 物件 c。從前只寫 c.alive，sweeper 永遠讀到 undefined
     → 第一輪設成 false，第二輪（30 秒後）就把健康連線 terminate 掉。 */
  ws.alive = true;
  ws.on('pong', () => { c.alive = true; ws.alive = true; });

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
      /* ---------- 排球（伺服器權威） ---------- */
      case 'start': {
        if (!c.room) return send(c, { t: 'err', msg: 'not in room' });
        if (c.role !== 'host') return send(c, { t: 'err', msg: 'only host can start' });
        const game = String(m.game || '');
        if (game !== 'volley' && game !== 'ox' && game !== 'memory' && game !== '2048') return send(c, { t: 'err', msg: 'unknown game' });
        if (game === 'volley' && !VOLLEY.ok) return send(c, { t: 'err', msg: 'volley unavailable' });
        if (game === 'ox' && !OX.ok) return send(c, { t: 'err', msg: 'ox unavailable' });
        if (game === 'memory' && !MEM.ok) return send(c, { t: 'err', msg: 'memory unavailable' });
        if (game === '2048' && !E2048.ok) return send(c, { t: 'err', msg: '2048 unavailable' });
        if (c.room.match && !c.room.match.over) return send(c, { t: 'err', msg: 'match already running' });
        try {
          c.room.match = (game === 'ox') ? newOxMatch()
                        : (game === 'memory') ? newMemoryMatch()
                        : (game === '2048') ? newMatch2048()
                        : newMatch();
        }
        catch (e) { return send(c, { t: 'err', msg: game + ' unavailable' }); }
        c.room.lastActive = now();
        sendBoth(c.room, { t: 'gstart', game });
        if (game === 'ox') broadcastOx(c.room, []);        // 立刻送第一包，兩邊不用等心跳
        if (game === 'memory') { c.room.match.lastTick = now(); broadcastMem(c.room, []); }
        if (game === '2048') { c.room.match.lastBc = now(); broadcast2048(c.room, []); }
        log('room', c.room.code, game, 'start');
        break;
      }
      /* 2048：離散指令，動了才送；死局後忽略 */
      case '2i': {
        if (!c.room || !c.room.match || c.room.match.game !== '2048') return;
        c.room.lastActive = now();
        const mt = c.room.match;
        const res = command2048(mt, c.role === 'host' ? 0 : 1, String(m.d || ''));
        if (res.ok) broadcast2048(c.room, res.ev);
        break;
      }
      case 'mi': {
        if (!c.room || !c.room.match || c.room.match.game !== 'memory') return;
        c.room.lastActive = now();
        const mt = c.room.match;
        if (mt.S.over) return;
        const res = memCommand(mt, c.role === 'host' ? 0 : 1, m.cmd);
        if (res.ok && res.ev.length) { mt.dirty = 0; broadcastMem(c.room, res.ev); }
        else if (res.ok) { mt.dirty = 1; }             // 只是移動游標 → 交給 10Hz tick 合併送出
        break;
      }
      case 'oi': {
        if (!c.room || !c.room.match || c.room.match.game !== 'ox') return;
        c.room.lastActive = now();
        const mt = c.room.match;
        if (mt.S.over) return;                        // 打完了 → 指令一律丟棄
        const res = oxCommand(mt, c.role === 'host' ? 0 : 1, m.cmd);
        if (res.ok) broadcastOx(c.room, res.ev);      // 狀態有變才廣播
        break;
      }
      case 'gi': {
        /* 輸入只作用在自己的 index；沒有比賽就忽略（不報錯，避免洗頻） */
        if (!c.room || !c.room.match) return;
        c.room.lastActive = now();
        setInput(c.room.match, c.role === 'host' ? 0 : 1, m.i);
        break;
      }
      /* ---------- 語音（06A）：純轉發，伺服器不懂 WebRTC ----------
         voice：開關狀態（讓對方知道要不要等）
         sig  ：offer／answer／ice，原封轉給房間裡的另一個人 */
      case 'voice': {
        if (!c.room) return;
        c.room.lastActive = now();
        const other = peerOf(c);
        if (other) send(other, { t: 'voice', from: c.role, on: !!m.on });
        break;
      }
      case 'sig': {
        if (!c.room) return;                       // 不在房間：忽略
        c.room.lastActive = now();
        const other = peerOf(c);
        if (!other) return;                        // 沒有對手：忽略（不報錯，避免洗頻）
        const kind = String(m.kind || '');
        if (kind !== 'offer' && kind !== 'answer' && kind !== 'ice')
          return send(c, { t: 'err', msg: 'bad sig kind' });
        const raw = JSON.stringify(m.data === undefined ? null : m.data);
        if (Buffer.byteLength(raw) > SIG_MAX)
          return send(c, { t: 'err', msg: 'sig too large' });
        send(other, { t: 'sig', from: c.role, kind, data: m.data });
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

/* ---------- 比賽心跳：30Hz 固定步長（伺服器權威） ----------
   為什麼不是 setInterval(33)：setInterval 的間隔會被事件迴圈拉長，直接拿它當 dt 會讓物理變慢。
   這裡用 10ms 的細 tick ＋ 每場自己的累積時間 acc，固定扣 1/30 秒，時間才不會漂。 */
const TICK_TIMER = setInterval(() => {
  const t = now();
  for (const r of rooms.values()) {
    const m = r.match;
    if (!m) continue;
    /* 2048：沒有 tick，只有「有動作就送 ＋ 1Hz 心跳」 */
    if (m.game === '2048') {
      if (!m.over && t - m.lastBc >= 1000) broadcast2048(r, []);
      continue;
    }
    /* 翻牌配對：10Hz 推進計時器（配對 1 秒、配錯 0.8 秒），狀態有變才廣播 */
    if (m.game === 'memory') {
      if (m.over) continue;
      if (t - m.lastTick < 100) continue;
      const dt = Math.min(0.25, (t - m.lastTick) / 1000);
      m.lastTick = t;
      const ev = memTickMatch(m, dt);
      if (ev.length) { m.dirty = 0; broadcastMem(r, ev); }
      else if (m.dirty) { m.dirty = 0; broadcastMem(r, []); }        // 游標移動合併成 10Hz 一包
      else if (t - m.lastBc >= 1000) broadcastMem(r, []);   // 1Hz 心跳
      continue;
    }
    /* 圈叉：沒有物理 → 不做 30Hz；只靠「有變化就送」＋ 500ms 心跳對齊 */
    if (m.game === 'ox') {
      if (!m.S.over && t - m.lastBc >= 500) broadcastOx(r, []);
      continue;
    }
    if (m.over) continue;
    m.acc += Math.min((t - m.lastMs) / 1000, 0.25);     // 上一次卡頓時最多補 0.25 秒
    m.lastMs = t;
    if (m.acc < TICK_S) continue;

    let evs = null, steps = 0;
    while (m.acc >= TICK_S && steps < 8 && !m.over) {    // 一次最多補 8 tick，避免雪球
      m.acc -= TICK_S;
      steps++;
      const ev = stepMatch(m, TICK_S);
      if (ev.length) evs = (evs || []).concat(ev);
    }
    if (!steps) continue;

    m.k++;
    const pkt = snapshot(m, evs);
    m.lastBytes = Buffer.byteLength(JSON.stringify(pkt));
    if (r.host)  send(r.host,  pkt);        // 同一份物件 → 兩邊內容一定相同
    if (r.guest) send(r.guest, pkt);
    if (m.over) {
      const end = { t: 'gend', win: m.winner };
      if (r.host)  send(r.host,  end);
      if (r.guest) send(r.guest, end);
      log('room', r.code, 'volley over, win', m.winner);
    }
  }
}, 10);
TICK_TIMER.unref?.();

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
