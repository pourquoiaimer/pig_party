/** 連線隨機派對端對端測試：用拔河（狂按）自動分勝負，驗證自動換關與總勝場 */
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

function conn() {
  const ws = new WebSocket(URL), all = [], w = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    all.push(m);
    for (let i = w.length - 1; i >= 0; i--) if (w[i].f(m)) { const x = w.splice(i, 1)[0]; x.r(m); }
  });
  return {
    ws, all,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    take: (f, ms = 6000) => new Promise((res) => {
      const hit = all.find(f); if (hit) return res(hit);
      const x = { f, r: res }; w.push(x);
      setTimeout(() => { const i = w.indexOf(x); if (i >= 0) w.splice(i, 1); res(null); }, ms);
    }),
    clear: () => { all.length = 0; },
    close: () => ws.close(),
  };
}

const A = conn(); await A.open(); A.send({ t: 'create', name: '房主', want: '4321' });
const room = await A.take((m) => m.t === 'room');
const B = conn(); await B.open(); B.send({ t: 'join', code: room.code, name: '挑戰者' });
await B.take((m) => m.t === 'room');
await A.take((m) => m.t === 'peer' && m.on === true);
console.log('房間', room.code);

ok('房碼是 4 位數字（指定的 4321）', /^[0-9]{4}$/.test(room.code) && room.code === '4321', room.code);

/* ---- 開派對（指定 2 關都玩拔河，方便自動分勝負） ---- */
A.clear(); B.clear();
A.send({ t: 'party', n: 2, list: ['tug', 'tug'] });
const pn1 = await A.take((m) => m.t === 'partyNext');
const gs1 = await A.take((m) => m.t === 'gstart');
ok('派對開始 → partyNext 第 1/2 關', !!pn1 && pn1.idx === 0 && pn1.n === 2 && pn1.game === 'tug', JSON.stringify(pn1));
ok('緊接著自動開第一關（gstart tug）', !!gs1 && gs1.game === 'tug', JSON.stringify(gs1));
ok('B 也收到同樣的 gstart', !!(await B.take((m) => m.t === 'gstart' && m.game === 'tug')));

/* ---- 第 1 關：A 狂按到贏 ---- */
for (let i = 0; i < 40; i++) { A.send({ t: 'ti' }); await sleep(60); }   // 每人 20 次/秒上限 → 慢慢按才拉得動
const end1 = await A.take((m) => m.t === 'gend', 4000);
ok('第 1 關結束（gend win=0）', !!end1 && end1.win === 0, JSON.stringify(end1));

/* ---- 4 秒後自動換第 2 關 ---- */
A.clear();
const pn2 = await A.take((m) => m.t === 'partyNext', 9000);
ok('自動進入第 2 關（partyNext idx=1、帶目前勝場 1:0）',
   !!pn2 && pn2.idx === 1 && pn2.wins[0] === 1 && pn2.wins[1] === 0, JSON.stringify(pn2 && { i: pn2.idx, w: pn2.wins }));
const gs2 = await A.take((m) => m.t === 'gstart', 4000);
ok('第 2 關 gstart 也到了', !!gs2 && gs2.game === 'tug', JSON.stringify(gs2));

/* ---- 第 2 關：B 狂按到贏 ---- */
for (let i = 0; i < 40; i++) { B.send({ t: 'ti' }); await sleep(60); }
const end2 = await A.take((m) => m.t === 'gend', 4000);
ok('第 2 關結束（gend win=1）', !!end2 && end2.win === 1, JSON.stringify(end2));

/* ---- 派對結束 → partyEnd 帶總勝場 ---- */
const pe = await A.take((m) => m.t === 'partyEnd', 9000);
ok('派對結束 → partyEnd 總勝場 1:1', !!pe && pe.wins[0] === 1 && pe.wins[1] === 1, JSON.stringify(pe));
const peB = await B.take((m) => m.t === 'partyEnd', 4000);
ok('B 也收到 partyEnd（兩邊一致）', !!peB && JSON.stringify(peB.wins) === JSON.stringify(pe.wins));

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
kill();
process.exit(fail ? 1 : 0);
