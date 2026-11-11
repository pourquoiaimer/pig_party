/**
 * 圈叉「伺服器權威」端對端測試（07）
 *
 * 自己 spawn 一台伺服器（PORT 8896），跑完關掉。
 * 重點：回合權限（非當前玩家的指令一律丟棄）、變了才送＋2Hz 心跳、流量。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8896);
const URL = `ws://127.0.0.1:${PORT}`;
const HTTP = `http://127.0.0.1:${PORT}`;

let WebSocket;
try { ({ WebSocket } = await import('ws')); }
catch { ({ default: WebSocket } = await import('../server/node_modules/ws/index.js')); }

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   → ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
srv.stderr.on('data', (d) => { srvLog += d; });
const killSrv = () => { try { srv.kill(); } catch (e) {} };
process.on('exit', killSrv);

let health = null;
for (let i = 0; i < 80; i++) {
  try { health = await (await fetch(HTTP + '/health')).json(); break; } catch { await sleep(100); }
}
if (!health) { console.log('伺服器沒起來\n' + srvLog); process.exit(1); }
console.log('health ox:', JSON.stringify(health.ox));

function conn() {
  const ws = new WebSocket(URL);
  const all = [], waiters = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    m.__bytes = raw.length;
    all.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(m)) { const w = waiters.splice(i, 1)[0]; w.resolve(m); }
    }
  });
  const api = {
    ws, all,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    take: (match, ms = 2500) => new Promise((resolve) => {
      const hit = all.find(match);
      if (hit) return resolve(hit);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) waiters.splice(j, 1); resolve(null); }, ms);
    }),
    clear: () => { all.length = 0; },
    gs: () => all.filter((m) => m.t === 'gs'),
    lastGs: () => { const a = all.filter((m) => m.t === 'gs'); return a[a.length - 1] || null; },
    close: () => ws.close(),
  };
  return api;
}

/* ---------- 開房間 ---------- */
const A = conn(); await A.open();
A.send({ t: 'create', name: '房主' });
const room = await A.take((m) => m.t === 'room');
const B = conn(); await B.open();
B.send({ t: 'join', code: room.code, name: '挑戰者' });
await B.take((m) => m.t === 'room');
await A.take((m) => m.t === 'peer' && m.on === true);
console.log('房間', room.code);

/* ---------- 1. 開賽 ---------- */
A.clear(); B.clear();
A.send({ t: 'start', game: 'ox' });
const gA = await A.take((m) => m.t === 'gstart');
const gB = await B.take((m) => m.t === 'gstart');
ok('host 開圈叉 → 兩邊都收到 gstart', !!gA && !!gB && gA.game === 'ox' && gB.game === 'ox',
   JSON.stringify([gA, gB]));
const firstA = await A.take((m) => m.t === 'gs');
ok('開賽後立刻有一包棋盤（不用等心跳）', !!firstA && Array.isArray(firstA.s.b) && firstA.s.b.length === 9,
   JSON.stringify(firstA && firstA.s));

/* ---------- 2. 回合鎖：非當前玩家連送 10 次 ---------- */
await sleep(120);
B.clear();
for (let i = 0; i < 10; i++) B.send({ t: 'oi', cmd: { a: 'confirm' } });   // guest，但現在是 host 的回合
await sleep(400);
const sAfterSpam = A.lastGs();
ok('非當前玩家連送 10 次 → 棋盤仍然全空', !!sAfterSpam && sAfterSpam.s.b.every(v => v === 0),
   JSON.stringify(sAfterSpam && sAfterSpam.s.b));
ok('非當前玩家連送 10 次 → 回合沒被推走（tn=0、mv=0）',
   !!sAfterSpam && sAfterSpam.s.tn === 0 && sAfterSpam.s.mv === 0,
   JSON.stringify(sAfterSpam && { tn: sAfterSpam.s.tn, mv: sAfterSpam.s.mv }));
ok('非當前玩家的指令不會產生任何「有事件」的廣播',
   B.gs().every(m => !m.ev || m.ev.length === 0), JSON.stringify(B.gs().map(m => m.ev)));

/* ---------- 3. 合法落子：兩邊逐位元組相同 ---------- */
B.clear();
A.clear();
A.send({ t: 'oi', cmd: { a: 'confirm' } });          // host 下在游標 4
const dropA = await A.take((m) => m.t === 'gs' && m.s.mv === 1);
const dropB = await B.take((m) => m.t === 'gs' && m.s.mv === 1);
ok('host 落子成功（board[4]=1、換手給 P2）',
   !!dropA && dropA.s.b[4] === 1 && dropA.s.tn === 1, JSON.stringify(dropA && dropA.s));
ok('兩邊收到的同一包 gs 逐位元組相同',
   !!dropA && !!dropB && dropA.__bytes === dropB.__bytes &&
   JSON.stringify(dropA.s) === JSON.stringify(dropB.s),
   `A=${dropA && dropA.__bytes} B=${dropB && dropB.__bytes}`);
ok('事件有帶 drop 與格子索引', !!dropA && dropA.ev.some(e => e.t === 'drop' && e.i === 4),
   JSON.stringify(dropA && dropA.ev));

/* ---------- 4. 空閒心跳：2Hz、不是 30Hz ---------- */
A.clear(); B.clear();
await sleep(2000);
const idleA = A.gs().length, idleB = B.gs().length;
ok('空閒 2 秒有 ≥2 則心跳（2Hz）', idleA >= 2 && idleB >= 2, `A=${idleA} B=${idleB}`);
ok('空閒 2 秒遠少於 30Hz 的 60 則（沒有洗頻）', idleA <= 8 && idleB <= 8, `A=${idleA} B=${idleB}`);
ok('心跳內容不含事件', A.gs().every(m => Array.isArray(m.ev) && m.ev.length === 0));

/* ---------- 5. 打到分出勝負 ---------- */
/* 目前盤面：P1 佔 4 號格（上面那步），輪到 P2。
   接下來 P2:3 → P1:7 → P2:0 → P1:1（P1 湊成 1,4,7 三連） */
let cursor = 4;
function moveCursor(client, target) {
  let r = Math.floor(cursor / 3), c = cursor % 3;
  const tr = Math.floor(target / 3), tc = target % 3;
  while (r !== tr) { if (r < tr) { client.send({ t: 'oi', cmd: { a: 'move', d: 'down' } }); r++; }
                     else         { client.send({ t: 'oi', cmd: { a: 'move', d: 'up' } });   r--; } }
  while (c !== tc) { if (c < tc) { client.send({ t: 'oi', cmd: { a: 'move', d: 'right' } }); c++; }
                     else         { client.send({ t: 'oi', cmd: { a: 'move', d: 'left' } });  c--; } }
  cursor = target;
}
async function moveAndDrop(client, idx) {
  const last = A.lastGs();
  cursor = last ? last.s.cur : 4;         // 游標以伺服器為準
  moveCursor(client, idx);
  await sleep(50);
  client.send({ t: 'oi', cmd: { a: 'confirm' } });
  await sleep(120);
}

await moveAndDrop(B, 3);   // P2
await moveAndDrop(A, 7);   // P1
await moveAndDrop(B, 0);   // P2
await moveAndDrop(A, 1);   // P1 → 1,4,7 連線

const winA = await A.take((m) => m.t === 'gend');
const winB = await B.take((m) => m.t === 'gend');
ok('三連線 → 兩邊都收到 gend 且 win 相同', !!winA && !!winB && winA.win === 0 && winB.win === 0,
   JSON.stringify([winA, winB]));
const fin = A.lastGs();
ok('最後一包棋盤：P1 佔 1、4、7',
   !!fin && fin.s.b[1] === 1 && fin.s.b[4] === 1 && fin.s.b[7] === 1,
   JSON.stringify(fin && fin.s.b));
ok('最後一包有 winLine [1,4,7]', !!fin && JSON.stringify(fin.s.wl) === '[1,4,7]',
   JSON.stringify(fin && fin.s.wl));
ok('最後一包 ov=1、win=0', !!fin && fin.s.ov === 1 && fin.s.win === 0,
   JSON.stringify(fin && { ov: fin.s.ov, win: fin.s.win }));
{
  const before = A.gs().length;
  A.send({ t: 'oi', cmd: { a: 'confirm' } });
  await sleep(400);
  ok('結束後送指令：沒有任何新的 gs', A.gs().length === before, `${before} → ${A.gs().length}`);
}

/* ---------- 6. 流量 ---------- */
{
  const pkts = A.gs();
  const total = pkts.reduce((s, m) => s + m.__bytes, 0);
  const avg = pkts.length ? Math.round(total / pkts.length) : 0;
  const span = (tt => tt)((pkts.length ? pkts[pkts.length - 1].k : 0));
  console.log(`    圈叉：${pkts.length} 包 / 共 ${total} bytes / 平均 ${avg} bytes/包`);
  console.log(`    對照：排球 30Hz 約 4.4 KB/s，圈叉這裡約 ${(total / 30 / 1024).toFixed(2)} KB/s（整場 30 秒攤平）`);
  ok('平均單包 < 200 bytes', avg > 0 && avg < 200, 'avg=' + avg);
  ok('整場（含心跳）總量 < 8 KB', total < 8192, 'total=' + total);
}

/* ---------- 7. 對手斷線 ---------- */
{
  A.send({ t: 'start', game: 'ox' });             // 再開一場
  await A.take((m) => m.t === 'gstart');
  await sleep(150);
  B.close();
  const gend = await A.take((m) => m.t === 'gend' && typeof m.reason === 'string', 4000);
  ok('對手斷線 → 另一方收到 gend（帶 reason）',
     !!gend && gend.reason.length > 0, JSON.stringify(gend));
}

A.close();
await sleep(200);

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
killSrv();
process.exit(fail ? 1 : 0);
