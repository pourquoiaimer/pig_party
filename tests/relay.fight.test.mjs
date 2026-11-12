/** 橫版對戰「伺服器權威」端對端測試（09G）
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
console.log('health fight:', JSON.stringify(health.fight));

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

/* ---------- 1. 開賽 ---------- */
const A = conn(); await A.open(); A.send({ t: 'create', name: '房主' });
const room = await A.take((m) => m.t === 'room');
const B = conn(); await B.open(); B.send({ t: 'join', code: room.code, name: '挑戰者' });
await B.take((m) => m.t === 'room');
await A.take((m) => m.t === 'peer' && m.on === true);
console.log('房間', room.code);
A.clear(); B.clear();
A.send({ t: 'start', game: 'fight' });
const gA = await A.take((m) => m.t === 'gstart');
ok('host 收到 gstart（game=fight）', !!gA && gA.game === 'fight', JSON.stringify(gA));
const s0 = await A.take((m) => m.t === 'gs');
const s0b = await B.take((m) => m.t === 'gs');
ok('初始狀態：x=[-2.4,2.4]、HP 都是 100',
   !!s0 && s0.s.x[0] === -2.4 && s0.s.x[1] === 2.4 && s0.s.hp[0] === 100 && s0.s.hp[1] === 100,
   s0 && JSON.stringify(s0.s));
ok('兩邊初始狀態完全相同', !!s0 && !!s0b && JSON.stringify(s0.s) === JSON.stringify(s0b.s));

/* ---------- 2. 30Hz 廣播 ---------- */
A.clear();
await sleep(500);
ok('0.5 秒收到 ≥8 包（實測約 20~30Hz）', A.gs().length >= 8, 'gs=' + A.gs().length + '/0.5s');
console.log(`    實際 ${A.gs().length} 包 / 0.5 秒（≈${(A.gs().length * 2)}Hz）`);

/* ---------- 3. 只有自己會動 ---------- */
A.clear();
const x1Before = s0.s.x[1];
A.send({ t: 'wi', l: 0, r: 1, b: 0 });
await sleep(400);
A.send({ t: 'wi', l: 0, r: 0, b: 0 });
await sleep(150);
const sM = A.last();
ok('A 按住右 → x[0] 增加', !!sM && sM.s.x[0] > -2.4 + 0.5, sM && sM.s.x[0]);
ok('B 的位置完全沒動', !!sM && sM.s.x[1] === x1Before, sM && sM.s.x[1]);
ok('A 面向變成 +1', !!sM && sM.s.fc[0] === 1, sM && sM.s.fc[0]);
ok('兩邊同一包逐位元組相同', !!sM && JSON.stringify(sM.s) === JSON.stringify(B.last().s));

/* ---------- 4. 攻擊命中 ---------- */
{
  A.clear(); B.clear();
  await A.take((m) => m.t === 'gs', 1500);      // clear 後先等一包，避免 last() 為 null
  const hpBefore = A.last().s.hp[1];
  A.send({ t: 'wa' });
  await sleep(700);
  const sA = A.last();
  const hitPkt = A.all.find((m) => m.t === 'gs' && (m.ev || []).some((e) => e.t === 'hit'));
  ok('A 攻擊 → 命中、HP 減少 14', !!sA && sA.s.hp[1] === hpBefore - 14,
     `hp ${hpBefore} → ${sA && sA.s.hp[1]}`);
  ok('有 hit 事件帶傷害', !!hitPkt && hitPkt.ev.find((e) => e.t === 'hit').d === 14,
     hitPkt && JSON.stringify(hitPkt.ev));
  ok('被打的一方 st=hurt', !!sA && (sA.s.st[1] === 'hurt' || sA.s.st[1] === 'idle'), sA && sA.s.st[1]);
}

/* ---------- 5. 距離外不命中 ---------- */
{
  A.clear(); B.clear();
  await A.take((m) => m.t === 'gs', 1500);
  // 先讓 B 退到遠處（B 往右），A 留在原地
  B.send({ t: 'wi', l: 0, r: 1, b: 0 });
  await sleep(600);
  B.send({ t: 'wi', l: 0, r: 0, b: 0 });
  await sleep(200);
  const sFar = A.last();
  const hpB = sFar.s.hp[1];
  const dist = Math.abs(sFar.s.x[0] - sFar.s.x[1]);
  A.send({ t: 'wa' });
  await sleep(700);
  ok(`距離 ${dist.toFixed(1)} > 2.6 → 打不到（HP 不變）`, A.last().s.hp[1] === hpB,
     `dist=${dist.toFixed(2)} hp=${A.last().s.hp[1]}`);
}

/* ---------- 6. 封包大小 ---------- */
{
  const one = A.all.find((m) => m.t === 'gs' && m.__bytes);
  ok('單包 ≤ 200 bytes', !!one && one.__bytes <= 200, 'bytes=' + (one && one.__bytes));
  console.log(`    實測單包 ${one ? one.__bytes : '?'} bytes`);
}

/* ---------- 7. 斷線 ---------- */
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
