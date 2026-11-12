/**
 * 翻牌配對「伺服器權威」端對端測試（09A）
 * 自己 spawn 一台伺服器（PORT 8897），跑完關掉。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8897);
const URL = `ws://127.0.0.1:${PORT}`;

let WebSocket;
try { ({ WebSocket } = await import('ws')); }
catch { ({ default: WebSocket } = await import('../server/node_modules/ws/index.js')); }

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '   → ' + e : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });
const kill = () => { try { srv.kill(); } catch (e) {} };
process.on('exit', kill);

let health = null;
for (let i = 0; i < 80; i++) {
  try { health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); break; } catch { await sleep(100); }
}
if (!health) { console.log('伺服器沒起來\n' + log); process.exit(1); }
console.log('health memory:', JSON.stringify(health.memory));

function conn() {
  const ws = new WebSocket(URL);
  const all = [], w = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    m.__bytes = raw.length;
    all.push(m);
    for (let i = w.length - 1; i >= 0; i--) if (w[i].f(m)) { const x = w.splice(i, 1)[0]; x.r(m); }
  });
  return {
    ws, all,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    take: (f, ms = 3000) => new Promise((res) => {
      const hit = all.find(f);
      if (hit) return res(hit);
      const x = { f, r: res }; w.push(x);
      setTimeout(() => { const i = w.indexOf(x); if (i >= 0) w.splice(i, 1); res(null); }, ms);
    }),
    clear: () => { all.length = 0; },
    gs: () => all.filter((m) => m.t === 'gs'),
    last: () => { const a = all.filter((m) => m.t === 'gs'); return a[a.length - 1] || null; },
    close: () => ws.close(),
  };
}

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
A.send({ t: 'start', game: 'memory' });
const gA = await A.take((m) => m.t === 'gstart');
const gB = await B.take((m) => m.t === 'gstart');
ok('兩邊都收到 gstart（game=memory）', !!gA && !!gB && gA.game === 'memory', JSON.stringify([gA, gB]));
const sA = await A.take((m) => m.t === 'gs');
const sB = await B.take((m) => m.t === 'gs');
ok('開賽立刻送牌堆（16 張）', !!sA && sA.s.d.length === 16 && sA.s.f.length === 16 && sA.s.g.length === 16);
ok('兩邊牌堆相同', sA && sB && sA.s.d === sB.s.d, (sA && sA.s.d) + ' vs ' + (sB && sB.s.d));

/* ---------- 2. 回合鎖：非當前玩家連送 10 次 ---------- */
await sleep(150);
B.clear();
for (let i = 0; i < 10; i++) B.send({ t: 'mi', cmd: { a: 'confirm' } });
await sleep(400);
const afterSpam = A.last();
ok('非當前玩家連送 10 次 → 一張都沒翻', !!afterSpam && afterSpam.s.f === '0000000000000000',
   afterSpam && afterSpam.s.f);
ok('回合沒被推走（tn=0、mv=0）', !!afterSpam && afterSpam.s.tn === 0 && afterSpam.s.mv === 0,
   JSON.stringify(afterSpam && { tn: afterSpam.s.tn, mv: afterSpam.s.mv }));

/* ---------- 3. 合法翻牌：兩邊逐位元組相同 ---------- */
B.clear(); A.clear();
A.send({ t: 'mi', cmd: { a: 'confirm' } });
const f1A = await A.take((m) => m.t === 'gs' && m.ev.some(e => e.t === 'flip'));
const f1B = await B.take((m) => m.t === 'gs' && m.ev.some(e => e.t === 'flip'));
ok('host 翻第一張 → 兩邊都看到', !!f1A && f1A.s.f[0] === '1' && !!f1B && f1B.s.f[0] === '1',
   JSON.stringify([f1A && f1A.s.f, f1B && f1B.s.f]));
ok('同一包 gs 兩邊逐位元組相同',
   !!f1A && !!f1B && f1A.__bytes === f1B.__bytes && JSON.stringify(f1A.s) === JSON.stringify(f1B.s),
   `${f1A && f1A.__bytes} vs ${f1B && f1B.__bytes}`);
ok('flip 事件帶格子索引', !!f1A && f1A.ev.some(e => e.t === 'flip' && e.i === 0), JSON.stringify(f1A && f1A.ev));

/* ---------- 4. 空閒心跳 ---------- */
A.clear(); B.clear();
await sleep(2200);
const hbA = A.gs().length, hbB = B.gs().length;
ok('空閒 2 秒有 ≥1 則心跳', hbA >= 1 && hbB >= 1, `A=${hbA} B=${hbB}`);
ok('空閒 2 秒遠少於 10Hz 的 20 則', hbA <= 4 && hbB <= 4, `A=${hbA} B=${hbB}`);

/* ---------- 5. 打到全部配完 ---------- */
const deck = sA.s.d.split('').map(Number);
const pairs = {};
deck.forEach((e, i) => { (pairs[e] = pairs[e] || []).push(i); });
let cursor = [0, 0];                       // P1 的游標（伺服器初始 (0,0)）
function movesTo(client, p, idx) {
  const tx = idx % 4, ty = (idx / 4) | 0;
  const cur = cursor;
  while (cur[0] !== tx) { client.send({ t: 'mi', cmd: { a: 'move', d: cur[0] < tx ? 'right' : 'left' } }); cur[0] += cur[0] < tx ? 1 : -1; }
  while (cur[1] !== ty) { client.send({ t: 'mi', cmd: { a: 'move', d: cur[1] < ty ? 'down' : 'up' } }); cur[1] += cur[1] < ty ? 1 : -1; }
}
const bytesBefore = A.gs().reduce((s, m) => s + m.__bytes, 0);
const gsCountBefore = A.gs().length;
const onePair = async (i0, i1) => {
  if (i0 !== null) { movesTo(A, 0, i0); await sleep(30); A.send({ t: 'mi', cmd: { a: 'confirm' } }); await sleep(70); }
  movesTo(A, 0, i1); await sleep(30); A.send({ t: 'mi', cmd: { a: 'confirm' } }); await sleep(70);
  await sleep(1150);                       // 等配對保持 1 秒後消失
};
/* 前面測「合法翻牌」時已經把 0 號格翻開 → 先補完那一對，再處理其餘 7 對 */
const p0 = pairs[deck[0]];
await onePair(null, p0[1]);
let turns = 1;
for (const e of Object.keys(pairs)) {
  if (pairs[e] === p0) continue;
  await onePair(pairs[e][0], pairs[e][1]);
  turns++;
  if (A.last() && A.last().s.ov === 1) break;
}
const fin = A.last();
ok(`8 對全部配完（${turns} 組）→ ov=1、P1 全拿 8 分`, !!fin && fin.s.ov === 1 && fin.s.sc[0] === 8,
   JSON.stringify(fin && { ov: fin.s.ov, sc: fin.s.sc }));
const gendA = await A.take((m) => m.t === 'gend');
const gendB = await B.take((m) => m.t === 'gend');
ok('兩邊都收到 gend、win 相同（0）', !!gendA && !!gendB && gendA.win === 0 && gendB.win === 0,
   JSON.stringify([gendA, gendB]));

/* ---------- 6. 流量 ---------- */
{
  const pkts = A.gs().slice(gsCountBefore);
  const total = pkts.reduce((s, m) => s + m.__bytes, 0);
  const avg = pkts.length ? Math.round(total / pkts.length) : 0;
  console.log(`    一局：${pkts.length} 包 / ${total} bytes / 平均 ${avg} bytes/包`);
  ok('單包 ≤ 250 bytes', avg > 0 && avg <= 250, 'avg=' + avg);
  ok('整局（8 對 16 次翻牌＋游標移動＋心跳）< 9 KB', total < 9216, 'total=' + total);
}

A.close(); B.close();
await sleep(150);
console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
kill();
process.exit(fail ? 1 : 0);
