/**
 * 拔河「伺服器權威」端對端測試（09C）
 * 自己 spawn 一台伺服器（PORT 8899），跑完關掉。
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
let srvlog = '';
srv.stdout.on('data', (d) => { srvlog += d; });
srv.stderr.on('data', (d) => { srvlog += d; });
const kill = () => { try { srv.kill(); } catch (e) {} };
process.on('exit', kill);

let health = null;
for (let i = 0; i < 80; i++) {
  try { health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); break; } catch { await sleep(100); }
}
if (!health) { console.log('伺服器沒起來\n' + srvlog); process.exit(1); }
console.log('health ok:', health.ok);

function conn() {
  const ws = new WebSocket(URL);
  const all = [], w = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    m.__bytes = raw.length; all.push(m);
    for (let i = w.length - 1; i >= 0; i--) if (w[i].f(m)) { const x = w.splice(i, 1)[0]; x.r(m); }
  });
  return {
    ws, all,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    take: (f, ms = 3000) => new Promise((res) => {
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
A.send({ t: 'start', game: 'tug' });
const gA = await A.take((m) => m.t === 'gstart');
const gB = await B.take((m) => m.t === 'gstart');
ok('兩邊都收到 gstart（game=tug）', !!gA && !!gB && gA.game === 'tug', JSON.stringify([gA, gB]));
const iA = await A.take((m) => m.t === 'gs');
ok('開賽立刻送繩子位置（r=0）', !!iA && iA.s.r === 0, JSON.stringify(iA && iA.s));

/* ---------- 2. 一拉 −7、互相抵消 ---------- */
A.clear(); B.clear();
for (let i = 0; i < 10; i++) { A.send({ t: 'ti' }); await sleep(12); }
await sleep(150);
ok('P1 按 10 次 → r = −70', A.last().s.r === -70, 'r=' + A.last().s.r);
for (let i = 0; i < 10; i++) { B.send({ t: 'ti' }); await sleep(12); }
await sleep(150);
ok('P2 按 10 次 → r = 0（互相抵消）', A.last().s.r === 0, 'r=' + A.last().s.r);
ok('兩邊同一包 gs 逐位元組相同',
   JSON.stringify(A.last().s) === JSON.stringify(B.last().s), 'A/B 不同步');

/* ---------- 3. 心跳：沒人按 → 2Hz ---------- */
A.clear(); B.clear();
await sleep(2200);
const hb = A.gs().length;
ok('沒人按 2 秒仍有 ≥2 則（2Hz 心跳）', hb >= 2, 'A=' + hb);
ok('沒人按 2 秒遠少於 60 則（不打 30Hz）', hb <= 12, 'A=' + hb);

/* ---------- 4. 速率限制：同一秒連送 100 次 ---------- */
await sleep(1100);                       // 讓上一秒的計數歸零
A.clear();
const t0 = Date.now();
for (let i = 0; i < 60; i++) { A.send({ t: 'ti' }); }   // 60 < 伺服器連線上限 90/s，才驗得到「每人 20/s」
await sleep(250);
const rNow = A.last().s.r;
ok('同一秒連送 60 次 → 只吃 20 次（r = −140）', rNow === -140, 'r=' + rNow);
const burstGs = A.gs().length;
console.log(`    連按期間 0.25 秒收到 ${burstGs} 包（每次拉都即時廣播）`);
ok('按鍵期間即時廣播（>10 包）', burstGs > 10, 'gs=' + burstGs);

/* ---------- 5. 拉到 −230 → gend ---------- */
await sleep(1100);
A.clear();
for (let i = 0; i < 13; i++) { A.send({ t: 'ti' }); await sleep(15); }   // −140 → −231 → 夾在 −230
const endA = await A.take((m) => m.t === 'gend');
const endB = await B.take((m) => m.t === 'gend');
ok('拉到 −230 → 兩邊都收到 gend、win=0', !!endA && !!endB && endA.win === 0 && endB.win === 0,
   JSON.stringify([endA, endB]));
ok('繩子夾在 −230', A.last().s.r === -230 && A.last().s.ov === 1, JSON.stringify(A.last().s));
{
  const before = A.gs().length, k = A.last().k;
  for (let i = 0; i < 5; i++) A.send({ t: 'ti' });
  await sleep(300);
  ok('結束後送指令 → 不產生新 gs', A.gs().length === before && A.last().k === k, `k ${k} → ${A.last().k}`);
}

/* ---------- 6. 流量 + dropped ---------- */
{
  const one = A.all.find(m => m.t === 'gs' && (m.ev || []).some(e => e.t === 'pull'));
  console.log(`    一次拉：${one ? one.__bytes : '?'} bytes（單包）`);
  ok('單包 ≤ 120 bytes', !!one && one.__bytes <= 120, 'bytes=' + (one && one.__bytes));
  await sleep(200);              // 等伺服器把「tug over ... dropped N」寫進 stdout（原本沒等 → 競態假失敗）
  const md = srvlog.match(/dropped (\d+)/);
  console.log(`    伺服器 dropped = ${md ? md[1] : '(未記錄)'}`);
  ok('速率限制有實際丟棄（dropped > 0）', !!md && Number(md[1]) > 0, md ? md[1] : 'log 沒有 dropped');
}

A.close(); B.close();
await sleep(120);
console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
kill();
process.exit(fail ? 1 : 0);
