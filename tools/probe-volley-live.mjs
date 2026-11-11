/**
 * 對「已部署的伺服器」驗排球通道（不 spawn、不依賴本機）
 * 用法：node tools/probe-volley-live.mjs wss://43.128.78.26:8890
 * 用途：部署後確認線上那台真的會跑排球權威邏輯，而不只是本地測試會過。
 */
const URL = process.argv[2] || 'wss://43.128.78.26:8890';
let WebSocket;
try { ({ WebSocket } = await import('ws')); }
catch { ({ default: WebSocket } = await import('../server/node_modules/ws/index.js')); }

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? ' → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function conn() {
  const ws = new WebSocket(URL, { rejectUnauthorized: false });
  const inbox = [], waiters = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  return {
    ws,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    take: (match, ms = 5000) => new Promise((resolve, reject) => {
      const i = inbox.findIndex(match);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const w = { match, resolve }; waiters.push(w);
      setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); reject(new Error('timeout')); } }, ms);
    }),
    /** 收集 1.5 秒內所有 gs */
    collect: async (ms) => { const out = []; const t = Date.now(); while (Date.now() - t < ms) { const g = await new Promise((res) => { const i = inbox.findIndex((m) => m.t === 'gs'); if (i >= 0) return res(inbox.splice(i, 1)[0]); const w = { match: (m) => m.t === 'gs', resolve: res }; waiters.push(w); setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); res(null); } }, ms); }); if (g) out.push(g); } return out; },
    close: () => ws.close(),
  };
}

console.log('目標：' + URL);
const A = conn(); await A.open();
A.send({ t: 'create', name: 'LIVE-A' });
const room = await A.take((m) => m.t === 'room');
ok('建立房間（線上）', !!room.code, JSON.stringify(room));

const B = conn(); await B.open();
B.send({ t: 'join', code: room.code, name: 'LIVE-B' });
await B.take((m) => m.t === 'room');
await A.take((m) => m.t === 'peer' && m.on === true);

A.send({ t: 'start', game: 'volley' });
const [ga, gb] = await Promise.all([A.take((m) => m.t === 'gstart'), B.take((m) => m.t === 'gstart')]);
ok('兩邊都收到 gstart', !!ga && !!gb);

const gsA = await A.collect(1500);
const gsB = await B.collect(200);
ok('30Hz 有在跑（1.5 秒 ≥40 則）', gsA.length >= 40, 'A 收到 ' + gsA.length);

// 同一 tick 內容必須完全相同（權威一致）
const mapB = new Map(gsB.map((g) => [g.k, JSON.stringify(g.s)]));
let same = 0, compared = 0;
for (const g of gsA) { const j = mapB.get(g.k); if (j !== undefined) { compared++; if (j === JSON.stringify(g.s)) same++; } }
ok('同 tick 兩邊狀態相同', compared > 0 && same === compared, `${same}/${compared}`);

const size = Math.max(...gsA.map((g) => JSON.stringify(g).length));
ok('單一 gs ≤ 220 bytes', size <= 220, size + ' bytes');

// 輸入路由：B 按右，只有 p[1] 動
const before = gsA[gsA.length - 1].s;
B.send({ t: 'gi', i: { l: 0, r: 1, u: 0 } });
const moved = await A.collect(600);
const after = moved[moved.length - 1].s;
B.send({ t: 'gi', i: { l: 0, r: 0, u: 0 } });
ok('guest 按右 → 自己的 p[1].x 變大', after.p[1][0] > before.p[1][0] + 50, `${before.p[1][0]} → ${after.p[1][0]}`);
ok('host 的 p[0].x 沒被影響', Math.abs(after.p[0][0] - before.p[0][0]) < 1, `${before.p[0][0]} → ${after.p[0][0]}`);
ok('有收到分數欄位', Array.isArray(after.sc), JSON.stringify(after.sc));

A.close(); B.close(); await sleep(200);
console.log(`\n通過 ${pass} ／ 失敗 ${fail}`);
process.exit(fail ? 1 : 0);
