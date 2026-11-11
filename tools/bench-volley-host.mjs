/**
 * 排球主機的記憶體／流量基準（跑 N 秒，印 rss 與封包量）
 * 用法：node tools/bench-volley-host.mjs [秒數=30] [埠=8896]
 * 自己啟動伺服器、自己關掉（這台機器背景服務會被環境砍）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const SECS = Number(process.argv[2] || 30);
const PORT = Number(process.argv[3] || 8896);
const ROOT = path.join(import.meta.dirname, '..');
const URL = `ws://127.0.0.1:${PORT}`, HTTP = `http://127.0.0.1:${PORT}`;
const { default: WebSocket } = await import('../server/node_modules/ws/index.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const kill = () => { try { srv.kill(); } catch (e) {} };
process.on('exit', kill);

let health = null;
for (let i = 0; i < 80; i++) {
  try { health = await (await fetch(HTTP + '/health')).json(); break; } catch { await sleep(100); }
}
if (!health) { console.log('伺服器沒起來'); process.exit(1); }
console.log('起始 rssMB', health.rssMB, '| volley', JSON.stringify(health.volley));

/** 連線 + inbox（listener 先掛好，避免和 send 競態） */
function conn() {
  const ws = new WebSocket(URL);
  const c = { ws, inbox: [], bytes: 0, pkts: 0 };
  ws.on('message', (d) => { c.inbox.push(d); c.bytes += d.length; c.pkts++; });
  c.send2 = (o) => ws.send(JSON.stringify(o));
  return c;
}
const waitFor = async (c, pred, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (let i = 0; i < c.inbox.length; i++) {
      const m = JSON.parse(c.inbox[i].toString());
      if (pred(m)) { c.inbox.splice(0, i + 1); return m; }
    }
    await sleep(20);
  }
  return null;
};

const A = conn(), B = conn();
await new Promise((r) => A.ws.once('open', r));
await new Promise((r) => B.ws.once('open', r));

A.send2({ t: 'create', name: 'benchA' });
const room = await waitFor(A, (m) => m.t === 'room');
if (!room) { console.log('開房失敗'); kill(); process.exit(1); }
B.send2({ t: 'join', code: room.code, name: 'benchB' });
await waitFor(B, (m) => m.t === 'room');
await sleep(150);
A.send2({ t: 'start', game: 'volley' });
A.bytes = 0; A.pkts = 0; B.bytes = 0; B.pkts = 0;   // 只算比賽期間

let alive = true;
const t0 = Date.now();
while (alive && (Date.now() - t0) / 1000 < SECS) {
  await sleep(1000);
  // 兩邊亂按，讓比賽真的跑（有擊球、得分、重置）
  const k = (Date.now() - t0) / 1000;
  A.send2({ t: 'gi', i: { l: Math.sin(k) < 0 ? 1 : 0, r: Math.sin(k) > 0 ? 1 : 0, u: Math.sin(k * 2) > 0.75 ? 1 : 0 } });
  B.send2({ t: 'gi', i: { l: Math.cos(k) < 0 ? 1 : 0, r: Math.cos(k) > 0 ? 1 : 0, u: 0 } });
  const h = await (await fetch(HTTP + '/health')).json();
  console.log(`  ${String(Math.round(k)).padStart(2)}s  rss ${h.rssMB} MB  matches ${h.matches}`);
}
const h2 = await (await fetch(HTTP + '/health')).json();
console.log('結束 rssMB', h2.rssMB, '｜rss 變化', (h2.rssMB - health.rssMB).toFixed(1), 'MB');
console.log(`封包：A ${A.pkts} 則 / ${(A.bytes / 1024).toFixed(1)} KB，B ${B.pkts} 則 / ${(B.bytes / 1024).toFixed(1)} KB`);
const secs = (Date.now() - t0) / 1000;
console.log(`平均 ${(A.bytes / secs / 1024 * 8).toFixed(1)} kbit/s per client（30Hz 排球）`);
A.ws.close(); B.ws.close();
kill();
process.exit(0);
