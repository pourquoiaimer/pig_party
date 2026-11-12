/**
 * 障礙賽跑「伺服器權威」端對端測試（09D）。自己 spawn 伺服器（PORT 8898）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8898);
const URL = `ws://127.0.0.1:${PORT}`;
let WebSocket;
try { ({ WebSocket } = await import('ws')); }
catch { ({ default: WebSocket } = await import('../server/node_modules/ws/index.js')); }

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '   → ' + e : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvlog = '';
srv.stdout.on('data', (d) => { srvlog += d; });
srv.stderr.on('data', (d) => { srvlog += d; });
const kill = () => { try { srv.kill(); } catch (e) {} };
process.on('exit', kill);
let health = null;
for (let i = 0; i < 80; i++) { try { health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); break; } catch { await sleep(100); } }
if (!health) { console.log('伺服器沒起來\n' + srvlog); process.exit(1); }
console.log('health race:', JSON.stringify(health.race));

function conn() {
  const ws = new WebSocket(URL), all = [], w = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    m.__bytes = raw.length; all.push(m);
    for (let i = w.length - 1; i >= 0; i--) if (w[i].f(m)) { const x = w.splice(i, 1)[0]; x.r(m); }
  });
  return { ws, all,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    take: (f, ms = 4000) => new Promise((res) => {
      const hit = all.find(f); if (hit) return res(hit);
      const x = { f, r: res }; w.push(x);
      setTimeout(() => { const i = w.indexOf(x); if (i >= 0) w.splice(i, 1); res(null); }, ms);
    }),
    clear: () => { all.length = 0; },
    gs: () => all.filter((m) => m.t === 'gs'),
    last: () => { const a = all.filter((m) => m.t === 'gs'); return a[a.length - 1] || null; },
    close: () => ws.close() };
}

const A = conn(); await A.open();
A.send({ t: 'create', name: '房主' });
const room = await A.take((m) => m.t === 'room');
const B = conn(); await B.open();
B.send({ t: 'join', code: room.code, name: '挑戰者' });
await B.take((m) => m.t === 'room');
await A.take((m) => m.t === 'peer' && m.on === true);
console.log('房間', room.code);

A.clear(); B.clear();
A.send({ t: 'start', game: 'race' });
const gA = await A.take((m) => m.t === 'gstart');
ok('兩邊都收到 gstart（game=race）', !!gA && gA.game === 'race', JSON.stringify(gA));
const s0 = await A.take((m) => m.t === 'gs');
ok('開賽立刻有快照（x=[60,60]）', !!s0 && s0.s.x[0] === 60 && s0.s.x[1] === 60, JSON.stringify(s0 && s0.s));

/* A 按右 → 只有 x[0] */
const bx = A.last().s;
A.clear(); B.clear();
A.send({ t: 'ri', d: 'right' });
await sleep(150);
const m1 = A.last();
ok('A 按 right → x[0] 增加、x[1] 不動',
   !!m1 && m1.s.x[0] > bx.x[0] && m1.s.x[1] === bx.x[1],
   JSON.stringify({ before: bx.x, after: m1 && m1.s.x }));
ok('兩邊同一包 gs 逐位元組相同',
   !!m1 && JSON.stringify(m1.s) === JSON.stringify(B.last().s));

/* B 按右 → 只有 x[1] */
const bx2 = A.last().s;
B.clear();
B.send({ t: 'ri', d: 'right' });
await sleep(150);
const m2 = A.last();
ok('B 按 right → 只有 x[1] 動', !!m2 && m2.s.x[1] > bx2.x[1], JSON.stringify(bx2.x) + ' → ' + JSON.stringify(m2 && m2.s.x));
ok('B 的指令沒有動到 A 的跑道（x[0] 不變）', !!m2 && m2.s.x[0] === bx2.x[0],
   JSON.stringify({ before: bx2.x, after: m2 && m2.s.x }));

/* 心跳：沒人按 → 2Hz */
A.clear();
await sleep(2200);
const hb = A.gs().length;
ok('沒人按 2 秒心跳 ≥1 且 <20', hb >= 1 && hb < 20, 'A=' + hb);

/* 速率限制：同秒 40 次 → 只吃 15 次（x 增加 15×22=330 以內） */
await sleep(1100);
const xB = A.last().s.x[0];
for (let i = 0; i < 40; i++) A.send({ t: 'ri', d: 'right' });
await sleep(250);
const xA = A.last().s.x[0];
ok(`同秒連送 40 次 → 只吃 15 次（Δx=${xA - xB}，上限 330）`, xA - xB > 0 && xA - xB <= 330, `Δ=${xA - xB}`);

/* 一路跑到終點（邊跳邊衝） */
let ended = null;
for (let round = 0; round < 26 && !ended; round++) {
  A.send({ t: 'ri', d: 'up' });
  for (let i = 0; i < 8; i++) { A.send({ t: 'ri', d: 'right' }); await sleep(66); }
  await sleep(700);
  ended = await A.take((m) => m.t === 'gend', 300);
}
const endB = ended ? await B.take((m) => m.t === 'gend', 1500) : null;
ok('跑到終點 → 兩邊 gend 且 win 相同',
   !!ended && !!endB && ended.win === endB.win, JSON.stringify([ended, endB]));
if (ended) {
  const before = A.gs().length, k = A.last().k;
  for (let i = 0; i < 5; i++) A.send({ t: 'ri', d: 'right' });
  await sleep(300);
  ok('結束後送指令 → 不產生新 gs', A.gs().length === before && A.last().k === k, `k ${k} → ${A.last().k}`);
}
{
  const one = A.all.find(m => m.t === 'gs' && (m.ev || []).some(e => e.t === 'hit'));
  console.log(`    含 hit 的包：${one ? one.__bytes : '?'} bytes`);
  const md = srvlog.match(/dropped (\d+)/);
  if (md) console.log(`    伺服器 dropped = ${md[1]}`);
  ok('單包 ≤ 200 bytes', A.gs().every(m => m.__bytes <= 200), 'max=' + Math.max(...A.gs().map(m => m.__bytes)));
}

A.close(); B.close(); await sleep(120);
console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
kill();
process.exit(fail ? 1 : 0);
