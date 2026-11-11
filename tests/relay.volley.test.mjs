/**
 * 排球「伺服器權威」端對端測試（05B）
 *
 * 跑法：node tests/relay.volley.test.mjs
 *   自己 spawn 一台伺服器（PORT 8895），跑完自動關掉 —— 這台機器背景 node 服務會被環境砍掉，
 *   所以「啟動 → 測試 → 關閉」必須在同一支腳本裡完成。
 *
 * 驗什麼：
 *   1. host 發 start → 兩邊都收到 gstart
 *   2. 2 秒內兩邊各收到 ≥40 個 gs（30Hz 有在跑）
 *   3. 同一 tick 兩邊收到的 s 完全相同（權威一致）
 *   4. 輸入路由：guest 的 gi 只動 index 1，host 的 p[0] 不受影響
 *   5. 比分變化兩邊一致
 *   6. 非 host 發 start / 未知 game 的錯誤訊息
 *   7. guest 斷線 → host 收到 gend（reason 有值）
 *   8. 單一 gs 封包 ≤ 220 bytes
 *   9. 回歸：tests/relay.test.mjs 全過
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
const waitFor = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(20); }
  return null;
};

/* ---------------- 啟動伺服器 ---------------- */
console.log(`啟動伺服器：${URL}`);
const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d.toString(); });
srv.stderr.on('data', (d) => { srvLog += d.toString(); });
const killSrv = () => { try { srv.kill(); } catch (e) {} };
process.on('exit', killSrv);

let health = null;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(HTTP + '/health'); health = await r.json(); break; }
  catch (e) { await sleep(100); }
}
if (!health) { console.log('伺服器沒起來：\n' + srvLog); process.exit(1); }
console.log('health:', JSON.stringify(health));

/* ---------------- 客戶端 ---------------- */
function conn() {
  const ws = new WebSocket(URL);
  const all = [];
  const waiters = [];
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
    take: (match, ms = 4000) => new Promise((resolve) => {
      const hit = all.find(match);
      if (hit) return resolve(hit);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j >= 0) waiters.splice(j, 1);
        resolve(null);
      }, ms);
    }),
    gs: () => all.filter((m) => m.t === 'gs'),
    close: () => ws.close(),
  };
  return api;
}

/* ---------------- 開房間 ---------------- */
const A = conn(); await A.open();
A.send({ t: 'create', name: '房主' });
const roomA = await A.take((m) => m.t === 'room');
ok('建立房間（回歸）', !!roomA && /^[A-Z2-9]{4}$/.test(roomA.code || ''), JSON.stringify(roomA));

const B = conn(); await B.open();
B.send({ t: 'join', code: roomA.code, name: '挑戰者' });
const roomB = await B.take((m) => m.t === 'room');
ok('加入房間（回歸）', !!roomB && roomB.role === 'guest');
await A.take((m) => m.t === 'peer' && m.on === true);

/* ---------------- 錯誤處理 ---------------- */
B.send({ t: 'start', game: 'volley' });
const errGuest = await B.take((m) => m.t === 'err');
ok('guest 發 start → err only host can start',
   !!errGuest && errGuest.msg === 'only host can start', JSON.stringify(errGuest));

A.send({ t: 'start', game: 'nope' });
const errGame = await A.take((m) => m.t === 'err');
ok('未知 game → err unknown game', !!errGame && errGame.msg === 'unknown game', JSON.stringify(errGame));

/* 還沒有比賽時送 gi：應該靜默忽略（不報錯、不斷線），避免前端亂送洗頻 */
const errBefore = B.all.filter((m) => m.t === 'err').length;
B.send({ t: 'gi', i: { r: 1 } });
await sleep(250);
B.send({ t: 'gi', i: { r: 0 } });
await sleep(120);
ok('沒有比賽時 gi 被忽略（沒有多出 err）',
   B.all.filter((m) => m.t === 'err').length === errBefore && B.ws.readyState === 1,
   'err 數=' + B.all.filter((m) => m.t === 'err').length);

/* ---------------- 1. host 開賽 ---------------- */
A.send({ t: 'start', game: 'volley' });
const gsA = await A.take((m) => m.t === 'gstart');
const gsB = await B.take((m) => m.t === 'gstart');
ok('host 發 start → 兩邊都收到 gstart',
   !!gsA && !!gsB && gsA.game === 'volley' && gsB.game === 'volley',
   JSON.stringify([gsA, gsB]));

/* ---------------- 4. 輸入路由（趁還沒得分前做） ---------------- */
const baseA = await waitFor(() => A.gs()[0]);
const p0Base = baseA ? baseA.s.p[0][0] : null;
const p1Base = baseA ? baseA.s.p[1][0] : null;
const t0 = Date.now();
while (Date.now() - t0 < 500) { B.send({ t: 'gi', i: { r: 1 } }); await sleep(33); }
B.send({ t: 'gi', i: { r: 0, l: 0, u: 0 } });
await sleep(120);
const during = A.gs();
const midA = during[during.length - 1];
ok('guest 的 gi 讓 p[1].x 變大（430 px/s × 0.5s）',
   midA && p1Base !== null && midA.s.p[1][0] - p1Base > 150,
   `p1 ${p1Base} → ${midA && midA.s.p[1][0]}`);
ok('host 沒送輸入 → p[0].x 不受影響',
   midA && p0Base !== null && Math.abs(midA.s.p[0][0] - p0Base) < 0.01,
   `p0 ${p0Base} → ${midA && midA.s.p[0][0]}`);

/* ---------------- 2. 30Hz 封包量 ---------------- */
const cntA0 = A.gs().length, cntB0 = B.gs().length;
await sleep(2000);
const nA = A.gs().length - cntA0, nB = B.gs().length - cntB0;
ok('2 秒內兩邊各收到 ≥40 個 gs（30Hz）', nA >= 40 && nB >= 40, `A=${nA} B=${nB}`);

/* ---------------- 3. 同一 tick 內容一致 ---------------- */
const mapA = new Map(), mapB = new Map();
for (const m of A.gs()) mapA.set(m.k, JSON.stringify(m.s));
for (const m of B.gs()) mapB.set(m.k, JSON.stringify(m.s));
let common = 0, mismatch = 0, firstBad = null;
for (const [k, s] of mapA) {
  if (!mapB.has(k)) continue;
  common++;
  if (mapB.get(k) !== s) { mismatch++; if (!firstBad) firstBad = k; }
}
ok('兩邊有共同 tick 可比對', common >= 30, 'common=' + common);
ok('同一 tick 兩邊 s 完全相同', common > 0 && mismatch === 0,
   `common=${common} mismatch=${mismatch} 第一個不同的 k=${firstBad}`);

/* k 必須嚴格遞增（前端用它丟掉亂序封包） */
let mono = true, lastK = -1;
for (const m of A.gs()) { if (m.k <= lastK) mono = false; lastK = m.k; }
ok('k 嚴格遞增', mono, 'last k=' + lastK);

/* ---------------- 5. 比分變化兩邊一致 ---------------- */
const scored = await waitFor(() => A.gs().find((m) => m.s.sc[0] + m.s.sc[1] > 0), 8000);
const scoredB = scored ? B.gs().find((m) => m.k === scored.k) : null;
ok('打到有一次得分（sc 變化）', !!scored, scored ? 'k=' + scored.k + ' sc=' + JSON.stringify(scored.s.sc) : '8 秒內沒有得分');
ok('得分那一 tick 兩邊比分相同',
   !!scoredB && JSON.stringify(scoredB.s.sc) === JSON.stringify(scored.s.sc),
   scoredB ? JSON.stringify(scoredB.s.sc) : 'B 沒有同 k 的封包');
ok('得分有帶 point 事件（前端播音效用）',
   !!scored && Array.isArray(scored.ev) && scored.ev.some((e) => e.t === 'point'),
   JSON.stringify(scored && scored.ev));

/* ---------------- 8. 封包大小 ---------------- */
let maxBytes = 0, maxPkt = null;
for (const m of A.all) {
  if (m.t !== 'gs') continue;
  const n = Buffer.byteLength(JSON.stringify(m));
  if (n > maxBytes) { maxBytes = n; maxPkt = JSON.stringify(m); }
}
ok('單一 gs 封包 ≤ 220 bytes', maxBytes > 0 && maxBytes <= 220, `max=${maxBytes}`);
console.log('    最大封包 ' + maxBytes + ' bytes：' + maxPkt);
{
  const idle = A.gs().find((m) => m.ev.length === 0 && m.s.mt === 0);
  console.log('    一般（無事件）封包 ' + (idle ? Buffer.byteLength(JSON.stringify(idle)) : '?') + ' bytes');
}

/* ---------------- 7. 斷線 ---------------- */
B.close();
const gend = await A.take((m) => m.t === 'gend', 4000);
ok('guest 斷線 → host 收到 gend 且有 reason',
   !!gend && gend.win === -1 && typeof gend.reason === 'string' && gend.reason.length > 0,
   JSON.stringify(gend));
const peerOff = await A.take((m) => m.t === 'peer' && m.on === false, 2000);
ok('房間行為不變：仍然收到 peer off', !!peerOff, JSON.stringify(peerOff));

A.close();
await sleep(200);

/* ---------------- 9. 回歸：原 relay 測試 ---------------- */
const reg = spawn(process.execPath, [path.join(ROOT, 'tests', 'relay.test.mjs'), URL], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let regOut = '';
reg.stdout.on('data', (d) => { regOut += d.toString(); });
reg.stderr.on('data', (d) => { regOut += d.toString(); });
const regCode = await new Promise((res) => reg.on('exit', res));
const regLine = (regOut.match(/通過 \d+ ／ 失敗 \d+ ／ 共 \d+/) || ['(no summary)'])[0];
ok('回歸：tests/relay.test.mjs 全過', regCode === 0, regLine + '\n' + regOut.slice(-400));
console.log('    relay.test.mjs → ' + regLine);

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');

killSrv();
process.exit(fail ? 1 : 0);
