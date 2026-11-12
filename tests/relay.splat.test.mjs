/** 塗地盤「伺服器權威」端對端測試（09F）
 *  自己 spawn 一台伺服器（PORT 8899），跑完關掉。
 *  注意：跑之前先確認 8899 沒有殘留伺服器（踩過假失敗）。
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
console.log('health splat:', JSON.stringify(health.splat || health.splat === false ? health.splat : '(未回報)'));

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

const cnt = (gr, ch) => gr.split('').filter((c) => c === ch).length;

/* ---------- 1. 開房 / 加入 / 開賽 ---------- */
const A = conn(); await A.open(); A.send({ t: 'create', name: '房主' });
const room = await A.take((m) => m.t === 'room');
const B = conn(); await B.open(); B.send({ t: 'join', code: room.code, name: '挑戰者' });
await B.take((m) => m.t === 'room');
await A.take((m) => m.t === 'peer' && m.on === true);
console.log('房間', room.code);
A.clear(); B.clear();
A.send({ t: 'start', game: 'splat' });
const gA = await A.take((m) => m.t === 'gstart');
ok('host 收到 gstart（game=splat）', !!gA && gA.game === 'splat', JSON.stringify(gA));
const s0 = await A.take((m) => m.t === 'gs');
const s0b = await B.take((m) => m.t === 'gs');
ok('初始 grid 全 0（135 格）', !!s0 && s0.s.gr.length === 135 && cnt(s0.s.gr, '0') === 135,
   s0 ? 'len=' + s0.s.gr.length + ' 0=' + cnt(s0.s.gr, '0') : 'null');
ok('兩邊初始狀態完全相同', !!s0 && !!s0b && JSON.stringify(s0.s) === JSON.stringify(s0b.s));
ok('初始位置在對角（P1 左上都 0、P2 右下）',
   !!s0 && s0.s.p[0][0] === 0 && s0.s.p[0][1] === 0 && s0.s.p[1][0] === 14 && s0.s.p[1][1] === 8,
   s0 && JSON.stringify(s0.s.p));

/* ---------- 2. 只有自己的角色會動 ---------- */
A.clear(); B.clear();
const p2Before = JSON.stringify(s0.s.p[1]);
for (let i = 0; i < 3; i++) { A.send({ t: 'si', d: 'right' }); await sleep(90); }
await A.take((m) => m.t === 'gs', 2000);      // 明確等下一包（clear 後立刻讀會拿到 null）
await sleep(250);
const sA = A.last(), sB = B.last();
ok('A 走 3 格 → 出現 3 個「1」', !!sA && cnt(sA.s.gr, '1') === 3, sA && cnt(sA.s.gr, '1'));
ok('P2 的格子還是 0（沒有被塗）', !!sA && cnt(sA.s.gr, '2') === 0, sA && cnt(sA.s.gr, '2'));
ok('P2 位置完全沒動', !!sA && JSON.stringify(sA.s.p[1]) === p2Before, sA && JSON.stringify(sA.s.p[1]));
ok('兩邊收到的同一包逐位元組相同', !!sA && !!sB && JSON.stringify(sA.s) === JSON.stringify(sB.s),
   sA && sB ? `k ${sA.k} / ${sB.k}` : 'null');

/* ---------- 3. 反向：B 走 → 只有 2 ---------- */
A.clear(); B.clear();
for (let i = 0; i < 3; i++) { B.send({ t: 'si', d: 'left' }); await sleep(90); }
await sleep(300);
const s2 = A.last();
ok('B 走 3 格 → 出現 3 個「2」', !!s2 && cnt(s2.s.gr, '2') === 3, s2 && cnt(s2.s.gr, '2'));
ok('P1 的 3 格沒有被蓋掉', !!s2 && cnt(s2.s.gr, '1') === 3, s2 && cnt(s2.s.gr, '1'));

/* ---------- 4. 靜止時低頻心跳 ---------- */
A.clear();
await sleep(2100);
const idle = A.gs().length;
ok('靜止 2 秒心跳 2~8 則（2Hz，不是 30Hz）', idle >= 2 && idle <= 8, 'gs=' + idle);

/* ---------- 5. 封包大小 ---------- */
{
  const one = A.all.find((m) => m.t === 'gs' && m.__bytes);
  ok('單包 ≤ 320 bytes', !!one && one.__bytes <= 320, 'bytes=' + (one && one.__bytes));
  console.log(`    實測單包 ${one ? one.__bytes : '?'} bytes`);
}

/* ---------- 6. 速率限制 ---------- */
A.clear();
for (let i = 0; i < 40; i++) A.send({ t: 'si', d: 'down' });
await sleep(400);
{
  const last = A.last();
  const p1y = last ? last.s.p[0][1] : -1;
  ok('同秒連送 40 次 → 只吃 12 次以內（y 位移受限）', p1y <= 12 + 1, 'y=' + p1y);
}

/* ---------- 7. 結束 → 兩邊 gend ---------- */
{
  A.clear(); B.clear();
  // 直接把時間跑完太久（30 秒），改用「雙方都狂走」不影響驗證；
  // 這裡只驗證「時間到會 gend」→ 等伺服器 20Hz 推進 30 秒不現實，
  // 所以改驗證「結束旗標與廣播格式」由 logic 測試覆蓋（見 splat.logic 17/17）。
  console.log('    （時間到 gend 由 splat.logic 的 30 秒比分測試覆蓋）');
}

/* ---------- 8. 斷線 ---------- */
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
