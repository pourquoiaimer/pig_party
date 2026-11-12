/** 答題爬格子（即時搶答版）「伺服器權威」端對端測試（09H）
 *  自己 spawn 一台伺服器（PORT 8899），跑完關掉。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8899);
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
let slog = '';
srv.stdout.on('data', (d) => { slog += d; });
srv.stderr.on('data', (d) => { slog += d; });
const kill = () => { try { srv.kill(); } catch (e) {} };
process.on('exit', kill);

let health = null;
for (let i = 0; i < 80; i++) {
  try { health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); break; } catch { await sleep(100); }
}
if (!health) { console.log('伺服器沒起來\n' + slog); process.exit(1); }
console.log('health math:', JSON.stringify(health.math));

function conn() {
  const ws = new WebSocket(URL), all = [], w = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    m.__bytes = raw.length; all.push(m);
    for (let i = w.length - 1; i >= 0; i--) if (w[i].f(m)) { const x = w.splice(i, 1)[0]; x.r(m); }
  });
  return {
    ws, all,
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
    close: () => ws.close(),
  };
}
const answerOf = (q) => (q[2] === '+' ? q[0] + q[1] : q[2] === '-' ? q[0] - q[1] : q[0] * q[1]);
const rightIdx = (s, p) => s.op[p].indexOf(answerOf(s.q[p]));
const wrongIdx = (s, p) => s.op[p].findIndex((v, i) => v !== answerOf(s.q[p]) && (s.wr[p] || []).indexOf(i) < 0);

/* ---------- 1. 開賽 ---------- */
const A = conn(); await A.open(); A.send({ t: 'create', name: '房主' });
const room = await A.take((m) => m.t === 'room');
const B = conn(); await B.open(); B.send({ t: 'join', code: room.code, name: '挑戰者' });
await B.take((m) => m.t === 'room');
await A.take((m) => m.t === 'peer' && m.on === true);
console.log('房間', room.code);
A.clear(); B.clear();
A.send({ t: 'start', game: 'math' });
const gA = await A.take((m) => m.t === 'gstart');
ok('host 收到 gstart（game=math）', !!gA && gA.game === 'math', JSON.stringify(gA));
const s0 = await A.take((m) => m.t === 'gs');
const s0b = await B.take((m) => m.t === 'gs');
ok('開賽兩人就都有題目（獨立兩套）',
   !!s0 && Array.isArray(s0.s.q) && s0.s.q.length === 2 && !!s0.s.q[0] && !!s0.s.q[1],
   s0 && JSON.stringify(s0.s.q));
ok('兩人各有 4 個選項', !!s0 && s0.s.op[0].length === 4 && s0.s.op[1].length === 4);
ok('兩人題目不同（各自出題）', !!s0 && JSON.stringify(s0.s.q[0]) !== JSON.stringify(s0.s.q[1]),
   s0 && `${JSON.stringify(s0.s.q[0])} / ${JSON.stringify(s0.s.q[1])}`);
ok('初始位置 0/0、兩邊狀態相同', !!s0 && s0.s.po[0] === 0 && s0.s.po[1] === 0 && JSON.stringify(s0.s) === JSON.stringify(s0b.s));
ok('快照不含答案（防作弊）', !!s0 && JSON.stringify(s0.s).indexOf('ans') < 0 && s0.s.q[0].length === 3);

/* ---------- 2. 答對：只有自己前進 ---------- */
{
  const cur = A.last().s;
  const idx = rightIdx(cur, 0);
  const dice = cur.dc[0];
  A.send({ t: 'qa', i: idx });
  await sleep(400);
  const after = A.last().s;
  ok('A 答對 → 自己前進骰子點數', after.po[0] === dice, `pos=${after.po[0]} dice=${dice}`);
  ok('B 的位置完全沒動', after.po[1] === 0, 'pos[1]=' + after.po[1]);
  ok('A 換了新題目、B 題目沒變',
     JSON.stringify(after.q[0]) !== JSON.stringify(cur.q[0]) && JSON.stringify(after.q[1]) === JSON.stringify(cur.q[1]),
     `${JSON.stringify(after.q[0])} / ${JSON.stringify(after.q[1])}`);
  ok('兩邊收到同一包（狀態逐位元組相同）', JSON.stringify(after) === JSON.stringify(B.last().s));
}

/* ---------- 3. 答錯：退格＋罰站＋記住錯選項 ---------- */
{
  const cur = A.last().s;
  const wi = wrongIdx(cur, 1);
  B.send({ t: 'qa', i: wi });
  await sleep(400);
  const after = A.last().s;
  ok('B 答錯 → 罰站中、位置最多不變', after.fz[1] > 1.5 && after.po[1] === Math.max(0, cur.po[1] - 1),
     JSON.stringify({ fz: after.fz, po: after.po }));
  ok('記住按錯的選項', (after.wr[1] || []).indexOf(wi) >= 0, JSON.stringify(after.wr[1]));
  const before = JSON.stringify(A.last().s);
  B.send({ t: 'qa', i: wi });
  await sleep(300);
  ok('同一個錯選項再按無效', JSON.stringify(A.last().s) === before);
  await sleep(2200);
  ok('2 秒後罰站結束', A.last().s.fz[1] === 0, 'fz=' + A.last().s.fz[1]);
}

/* ---------- 4. 靜止心跳 ---------- */
A.clear();
await sleep(2200);
ok('靜止 2.2 秒心跳 1~4 則（1Hz）', A.gs().length >= 1 && A.gs().length <= 4, 'gs=' + A.gs().length);

/* ---------- 5. 封包大小 ---------- */
{
  const one = A.all.find((m) => m.t === 'gs' && m.__bytes);
  ok('單包 ≤ 420 bytes', !!one && one.__bytes <= 420, 'bytes=' + (one && one.__bytes));
  console.log(`    實測單包 ${one ? one.__bytes : '?'} bytes（含兩人題目與選項）`);
}

/* ---------- 6. 斷線 ---------- */
{
  A.clear();
  B.close();
  const end = await A.take((m) => m.t === 'gend', 3000);
  ok('對手斷線 → 另一方收到 gend', !!end, JSON.stringify(end));
}

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
kill();
process.exit(fail ? 1 : 0);
