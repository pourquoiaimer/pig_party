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
const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = ''; srv.stdout.on('data', d => slog += d); srv.stderr.on('data', d => slog += d);
const kill = () => { try { srv.kill(); } catch (e) {} };
process.on('exit', kill);
let health = null;
for (let i = 0; i < 80; i++) { try { health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); break; } catch { await sleep(100); } }
if (!health) { console.log('伺服器沒起來\n' + slog); process.exit(1); }
console.log('health fruit:', JSON.stringify(health.fruit));
function conn() {
  const ws = new WebSocket(URL), all = [], w = [];
  ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; } m.__bytes = raw.length; all.push(m); for (let i = w.length - 1; i >= 0; i--) if (w[i].f(m)) { const x = w.splice(i, 1)[0]; x.r(m); } });
  return { ws, all, open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    take: (f, ms = 4000) => new Promise((res) => { const hit = all.find(f); if (hit) return res(hit); const x = { f, r: res }; w.push(x); setTimeout(() => { const i = w.indexOf(x); if (i >= 0) w.splice(i, 1); res(null); }, ms); }),
    clear: () => { all.length = 0; }, gs: () => all.filter(m => m.t === 'gs'),
    last: () => { const a = all.filter(m => m.t === 'gs'); return a[a.length - 1] || null; }, close: () => ws.close() };
}
const A = conn(); await A.open(); A.send({ t: 'create', name: '房主' });
const room = await A.take(m => m.t === 'room');
const B = conn(); await B.open(); B.send({ t: 'join', code: room.code, name: '挑戰者' });
await B.take(m => m.t === 'room');
await A.take(m => m.t === 'peer' && m.on === true);
console.log('房間', room.code);
A.clear(); B.clear();
A.send({ t: 'start', game: 'fruit' });
const gA = await A.take(m => m.t === 'gstart');
ok('兩邊都收到 gstart（game=fruit）', !!gA && gA.game === 'fruit', JSON.stringify(gA));
const s0 = await A.take(m => m.t === 'gs');
const s0b = await B.take(m => m.t === 'gs');
ok('初始 px=[240,720]', !!s0 && s0.s.px[0] === 240 && s0.s.px[1] === 720, JSON.stringify(s0 && s0.s.px));
ok('兩邊初始狀態完全相同（水果由伺服器生）', !!s0 && !!s0b && JSON.stringify(s0.s) === JSON.stringify(s0b.s));
const px0 = A.last().s.px;
A.clear(); B.clear();
A.send({ t: 'fi', l: 1, r: 0 });
await sleep(300);
const m1 = A.last();
ok('A 送 {l:1} 300ms → px[0] 變小、px[1] 不動',
   !!m1 && m1.s.px[0] < px0[0] - 50 && m1.s.px[1] === px0[1],
   JSON.stringify({ before: px0, after: m1 && m1.s.px }));
ok('同一包 gs 兩邊逐位元組相同', !!m1 && JSON.stringify(m1.s) === JSON.stringify(B.last().s));
A.send({ t: 'fi', l: 0, r: 0 });
await sleep(150);
const px1 = A.last().s.px;
B.clear();
B.send({ t: 'fi', l: 0, r: 1 });
await sleep(300);
const m2 = A.last();
ok('B 送 {r:1} → 只有 px[1] 變大、px[0] 不動',
   !!m2 && m2.s.px[1] > px1[1] + 50 && m2.s.px[0] === px1[0], JSON.stringify({ before: px1, after: m2 && m2.s.px }));
B.send({ t: 'fi', l: 0, r: 0 });
A.clear();
await sleep(2200);
const hb = A.gs().length;
ok('閒置 2 秒心跳 ≥1 且 <20', hb >= 1 && hb < 20, 'gs=' + hb);
ok('單包 ≤ 300 bytes', A.gs().every(m => m.__bytes <= 300), 'max=' + Math.max(...A.gs().map(m => m.__bytes)));
{ const one = A.gs().find(m => (m.s.it || []).length > 0); console.log(`    含水果的包：${one ? one.__bytes : '?'} bytes，水果數 ${one ? one.s.it.length : 0}`); }
const eat = A.all.find(m => (m.ev || []).some(e => e.t === 'eat'));
console.log('    eat 事件：', eat ? JSON.stringify(eat.ev) : '（這段時間沒接到，正常）');
A.close(); B.close(); await sleep(120);
console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
kill();
process.exit(fail ? 1 : 0);
