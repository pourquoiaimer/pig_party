/**
 * 驗證「Caddy TLS → WebSocket upgrade → Node 中繼」整條路徑
 * 用途：在 VPS 本機測（外部防火牆還沒開時也能驗）
 *
 * 跑法：node wss-proxy.test.mjs [url] [hostHeader]
 *   node wss-proxy.test.mjs wss://127.0.0.1:8890 43.128.78.26:8890
 *
 * 為什麼要覆寫 Host：Caddy 的 site 位址是 https://43.128.78.26:8890，
 * 用 127.0.0.1 連時 Host 不符 → 會落到別的 server（回 200 但空 body）。
 */
const url = process.argv[2] || 'wss://127.0.0.1:8890';
const host = process.argv[3] || '43.128.78.26:8890';
const { WebSocket } = await import('ws');

const opts = { rejectUnauthorized: false, headers: { Host: host } };

function open(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.match(m));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else inbox.push(m);
    });
    ws.on('open', () => resolve({ ws, inbox, waiters, send: (o) => ws.send(JSON.stringify(o)),
      take: (match, ms = 4000) => new Promise((res, rej) => {
        const i = inbox.findIndex(match);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        const w = { match, resolve: res };
        waiters.push(w);
        setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); rej(new Error('timeout ' + name)); } }, ms);
      }) }));
    ws.on('error', (e) => reject(e));
  });
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

console.log('目標：' + url + '  (Host: ' + host + ')');
try {
  const A = await open('A');
  A.send({ t: 'create', name: 'TLS-A' });
  const room = await A.take((m) => m.t === 'room');
  ok('TLS 握手 + WebSocket upgrade + 建立房間', !!room.code, JSON.stringify(room));

  const B = await open('B');
  B.send({ t: 'join', code: room.code, name: 'TLS-B' });
  await B.take((m) => m.t === 'room');
  await A.take((m) => m.t === 'peer' && m.on === true);
  ok('第二個連線加入並互相通知', true);

  A.send({ t: 's', d: { x: 7, z: -3 } });
  const got = await B.take((m) => m.t === 's');
  ok('狀態經由 Caddy 轉發成功', got.d && got.d.x === 7, JSON.stringify(got));

  A.ws.close(); B.ws.close();
} catch (e) {
  fail++;
  console.log('  ✗ 連線失敗：' + e.message);
}
console.log(`\n通過 ${pass} ／ 失敗 ${fail}`);
process.exit(fail ? 1 : 0);
