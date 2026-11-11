/**
 * 語音 signaling 轉發測試（06A）
 *
 * 自己 spawn 一台伺服器（PORT 8895），跑完關掉（這台機器背景 node 會被環境砍）。
 * 驗：offer/answer/ice 轉給對手且 from 正確、沒有對手時忽略、>8KB 被拒、既有通道不受影響
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8895);
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

function conn() {
  const ws = new WebSocket(URL);
  const all = [], waiters = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
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
    close: () => ws.close(),
    clear: () => { all.length = 0; },
  };
  return api;
}

/* 1. 兩個客戶端進同一個房間 */
const A = conn(); await A.open();
A.send({ t: 'create', name: '房主' });
const room = await A.take((m) => m.t === 'room');
ok('建立房間（回歸）', !!room && /^[A-Z2-9]{4}$/.test(room.code || ''));

const B = conn(); await B.open();
B.send({ t: 'join', code: room.code, name: '挑戰者' });
await B.take((m) => m.t === 'room');
await A.take((m) => m.t === 'peer' && m.on === true);

/* 2. offer：host → guest，from 必須是 host */
A.send({ t: 'sig', kind: 'offer', data: { x: 1, sdp: 'v=0 fake-offer' } });
const off = await B.take((m) => m.t === 'sig');
ok('offer 轉給對手', !!off && off.kind === 'offer', JSON.stringify(off));
ok('offer 的 from 是 host', !!off && off.from === 'host', off && off.from);
ok('offer 的 data 原封不動', !!off && off.data && off.data.x === 1 && off.data.sdp === 'v=0 fake-offer',
   JSON.stringify(off && off.data));

/* 3. answer：guest → host，from 必須是 guest */
B.send({ t: 'sig', kind: 'answer', data: { sdp: 'v=0 fake-answer' } });
const ans = await A.take((m) => m.t === 'sig');
ok('answer 轉給對手', !!ans && ans.kind === 'answer', JSON.stringify(ans));
ok('answer 的 from 是 guest', !!ans && ans.from === 'guest', ans && ans.from);

/* 4. ice：兩邊互轉（ICE 會有很多則，這裡驗兩則） */
A.send({ t: 'sig', kind: 'ice', data: { candidate: 'cand-a' } });
B.send({ t: 'sig', kind: 'ice', data: { candidate: 'cand-b' } });
const iceB = await B.take((m) => m.t === 'sig' && m.kind === 'ice');
const iceA = await A.take((m) => m.t === 'sig' && m.kind === 'ice');
ok('ICE 雙向轉發', !!iceB && !!iceA && iceB.from === 'host' && iceA.from === 'guest',
   JSON.stringify([iceB, iceA]));

/* 5. voice 開關狀態也要轉 */
A.send({ t: 'voice', on: true });
const vB = await B.take((m) => m.t === 'voice');
ok('voice:on 轉給對手且 from 正確', !!vB && vB.on === true && vB.from === 'host', JSON.stringify(vB));
B.send({ t: 'voice', on: false });
const vA = await A.take((m) => m.t === 'voice');
ok('voice:off 轉給對手', !!vA && vA.on === false && vA.from === 'guest', JSON.stringify(vA));

/* 6. 超過 8 KB 被拒（不轉發） */
A.clear(); B.clear();
const big = 'x'.repeat(9000);
A.send({ t: 'sig', kind: 'offer', data: { sdp: big } });
const errBig = await A.take((m) => m.t === 'err');
const leaked = await B.take((m) => m.t === 'sig' && m.kind === 'offer', 600);
ok('>8KB 的 sig 被拒（回 err）', !!errBig && errBig.msg === 'sig too large', JSON.stringify(errBig));
ok('>8KB 的 sig 沒有被轉發', leaked === null, JSON.stringify(leaked));
ok('連線沒有因此斷掉', A.ws.readyState === 1 && B.ws.readyState === 1);

/* 7. 剛好 8 KB 以內要能過（SDP 真的可能接近上限） */
A.clear(); B.clear();
const near = 'y'.repeat(8000);
A.send({ t: 'sig', kind: 'offer', data: { sdp: near } });
const nearB = await B.take((m) => m.t === 'sig' && m.kind === 'offer');
ok('約 8KB（7990 bytes）仍可轉發', !!nearB && nearB.data.sdp.length === 8000,
   nearB ? String(nearB.data.sdp.length) : 'timeout');

/* 8. 沒有對手時送 sig：忽略、不報錯、不斷線 */
const C = conn(); await C.open();
C.send({ t: 'create', name: '孤單房主' });
await C.take((m) => m.t === 'room');
C.send({ t: 'sig', kind: 'offer', data: { sdp: 'lonely' } });
C.send({ t: 'voice', on: true });
await sleep(300);
const errC = C.all.find((m) => m.t === 'err');
ok('沒有對手時送 sig/voice 不會產生 err', !errC, JSON.stringify(errC));
ok('沒有對手時連線仍活著', C.ws.readyState === 1);

/* 9. 大廳 s 通道不受影響 */
A.send({ t: 's', d: { x: 3.5 } });
const sB = await B.take((m) => m.t === 's');
ok('大廳 s 轉發照舊', !!sB && sB.d.x === 3.5, JSON.stringify(sB));

A.close(); B.close(); C.close();
await sleep(200);

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
killSrv();
process.exit(fail ? 1 : 0);
