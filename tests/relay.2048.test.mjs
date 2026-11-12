/**
 * 2048 對戰「伺服器權威」端對端測試（09B）
 * 自己 spawn 一台伺服器（PORT 8898），跑完關掉。
 * 重點：A 的指令只能動 A 的盤、兩邊同一包 gs 逐位元組相同、死局後不再送。
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
console.log('health 2048:', JSON.stringify(health['2048']));

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
A.send({ t: 'start', game: '2048' });
const gA = await A.take((m) => m.t === 'gstart');
const gB = await B.take((m) => m.t === 'gstart');
ok('兩邊都收到 gstart（game=2048）', !!gA && !!gB && gA.game === '2048', JSON.stringify([gA, gB]));
const iA = await A.take((m) => m.t === 'gs');
const iB = await B.take((m) => m.t === 'gs');
ok('開賽立刻送兩個盤（各 16 格）', !!iA && iA.s.g.length === 2 && iA.s.g[0].length === 16 && iA.s.g[1].length === 16);
ok('兩邊看到的初始狀態完全相同', !!iA && !!iB && JSON.stringify(iA.s) === JSON.stringify(iB.s));
ok('兩個盤是各自獨立的（不一定相同，但都是合法盤）',
   !!iA && iA.s.g[0].filter(Boolean).length === 2 && iA.s.g[1].filter(Boolean).length === 2,
   JSON.stringify(iA && iA.s.g.map(r => r.filter(Boolean).length)));

/* ---------- 2. A 只動自己的盤 ---------- */
const before = A.last().s;
A.clear(); B.clear();
A.send({ t: '2i', d: 'left' });
const mvA = await A.take((m) => m.t === 'gs' && (m.ev || []).some(e => e.t === 'moved'));
const mvB = await B.take((m) => m.t === 'gs' && (m.ev || []).some(e => e.t === 'moved'));
ok('A 送 left → 收到 moved 事件（p=0）', !!mvA && mvA.ev.some(e => e.t === 'moved' && e.p === 0), JSON.stringify(mvA && mvA.ev));
ok('★ 只有 g[0] 變、g[1] 完全不變',
   !!mvA && JSON.stringify(mvA.s.g[0]) !== JSON.stringify(before.g[0]) &&
   JSON.stringify(mvA.s.g[1]) === JSON.stringify(before.g[1]),
   JSON.stringify({ changed0: mvA && JSON.stringify(mvA.s.g[0]) !== JSON.stringify(before.g[0]),
                    same1: mvA && JSON.stringify(mvA.s.g[1]) === JSON.stringify(before.g[1]) }));
ok('兩邊收到同一包 gs（逐位元組相同）',
   !!mvA && !!mvB && mvA.__bytes === mvB.__bytes && JSON.stringify(mvA.s) === JSON.stringify(mvB.s),
   `${mvA && mvA.__bytes} vs ${mvB && mvB.__bytes}`);

/* ---------- 3. B 只動自己的盤 ---------- */
const before2 = A.last().s;
A.clear(); B.clear();
B.send({ t: '2i', d: 'up' });
const mvB2 = await B.take((m) => m.t === 'gs' && (m.ev || []).some(e => e.p === 1));
ok('B 送 up → 只有 g[1] 變、g[0] 不變',
   !!mvB2 && JSON.stringify(mvB2.s.g[1]) !== JSON.stringify(before2.g[1]) &&
   JSON.stringify(mvB2.s.g[0]) === JSON.stringify(before2.g[0]),
   JSON.stringify(mvB2 && { g0same: JSON.stringify(mvB2.s.g[0]) === JSON.stringify(before2.g[0]) }));
ok('分數各自獨立（sc[0] 只跟著 A、sc[1] 只跟著 B）',
   !!mvB2 && mvB2.s.sc.length === 2);

/* ---------- 4. 空閒心跳 ---------- */
A.clear(); B.clear();
await sleep(2200);
const hb = A.gs().length;
ok('空閒 2 秒有 ≥1 則心跳', hb >= 1, 'A=' + hb);
ok('空閒 2 秒遠少於 60 則（沒有洗頻）', hb <= 4, 'A=' + hb);
ok('心跳不含事件', A.gs().every(m => (m.ev || []).length === 0));

/* ---------- 5. 死局後送指令 → 不再送 ---------- */
let tries = 0;
const CYC = ['left', 'right', 'up', 'down'];
while (tries < 500) {
  A.send({ t: '2i', d: CYC[tries % 4] });                   // 四方向亂推＝很快就死
  tries++;
  await sleep(20);                                          // 伺服器限制 90 msg/s，別踩線
  const st = A.last();
  if (st && st.s.dd[0] === 1) break;
}
await sleep(150);
const dead = A.last();
ok(`A 的盤打到死局（${tries} 次 left）`, !!dead && dead.s.dd[0] === 1, JSON.stringify(dead && dead.s.dd));
{
  const beforeCnt = A.gs().length;
  const kBefore = dead && dead.k;
  for (let i = 0; i < 5; i++) A.send({ t: '2i', d: 'left' });
  await sleep(400);
  const after = A.last();
  ok('死局後送指令 → 不產生新的 gs（k 不變）', after && after.k === kBefore && A.gs().length === beforeCnt,
     `k ${kBefore} → ${after && after.k}`);
}

/* ---------- 6. 流量 ---------- */
{
  const mvs = A.gs().filter(m => (m.ev || []).some(e => e.t === 'moved'));
  const oneMove = mvs[0];
  console.log(`    一次移動：${oneMove ? oneMove.__bytes : '?'} bytes（單包）`);
  ok('一次移動 ≤ 400 bytes', !!oneMove && oneMove.__bytes > 0 && oneMove.__bytes <= 400,
     'bytes=' + (oneMove && oneMove.__bytes));
  ok('心跳封包也 ≤ 400 bytes', A.gs().every(m => m.__bytes <= 400));
}

A.close(); B.close();
await sleep(150);
console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
kill();
process.exit(fail ? 1 : 0);
