/**
 * 連線伺服器的端對端測試（不需要瀏覽器）
 * 跑法：node tests/relay.test.mjs [ws://127.0.0.1:8890]
 *   在本機跑要先把 8890 埠 forwarding 過來，或直接在 VPS 上跑。
 *
 * 測的流程：建立房間 → 加入 → 雙向轉發 → 對手離線通知 → 錯誤處理（房間不存在／房間已滿）
 */
const URL = process.argv[2] || 'ws://127.0.0.1:8890';
const { WebSocket } = await import('ws');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   → ' + extra : '')); }
};

function conn() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) { const w = waiters.splice(i, 1)[0]; w.resolve(m); }
    else inbox.push(m);
  });
  const api = {
    ws,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    /** 等一則符合條件的訊息（先看有沒有已經收到的） */
    take: (match, ms = 3000) => new Promise((resolve, reject) => {
      const i = inbox.findIndex(match);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => {
        const j = waiters.indexOf(w);
        if (j >= 0) { waiters.splice(j, 1); reject(new Error('timeout waiting for message')); }
      }, ms);
    }),
    close: () => ws.close(),
  };
  return api;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('目標：' + URL);

/* 1. 建立房間 */
const A = conn();
await A.open();
A.send({ t: 'create', name: '小明' });
const room = await A.take((m) => m.t === 'room');
ok('建立房間回傳 4 碼房間碼', /^[A-Z2-9]{4}$/.test(room.code || ''), JSON.stringify(room));
ok('角色是 host', room.role === 'host');
const CODE = room.code;

/* 2. 加入房間 */
const B = conn();
await B.open();
B.send({ t: 'join', code: CODE, name: '小華' });
const roomB = await B.take((m) => m.t === 'room');
ok('加入成功且角色是 guest', roomB.role === 'guest', JSON.stringify(roomB));
ok('guest 看得到 host 名字', roomB.peer === '小明', String(roomB.peer));
const peerOn = await A.take((m) => m.t === 'peer' && m.on === true);
ok('host 收到「有人進來」通知', peerOn.name === '小華', JSON.stringify(peerOn));

/* 3. 雙向轉發 */
A.send({ t: 's', d: { x: 1.5, z: -2, f: 0.3, look: 'princess' } });
const gotByB = await B.take((m) => m.t === 's');
ok('guest 收到 host 的狀態', gotByB.d && gotByB.d.x === 1.5 && gotByB.d.look === 'princess', JSON.stringify(gotByB));

B.send({ t: 's', d: { x: -1, z: 3, f: 2.1, look: 'hero' } });
const gotByA = await A.take((m) => m.t === 's');
ok('host 收到 guest 的狀態', gotByA.d && gotByA.d.z === 3, JSON.stringify(gotByA));

/* 4. 30Hz 連續送 60 則（2 秒），確認不會被速率限制誤殺 */
const before = B.ws._closeCode;
for (let i = 0; i < 60; i++) { A.send({ t: 's', d: { x: i } }); await sleep(33); }
await sleep(300);
ok('30Hz 連送 2 秒沒被切斷', A.ws.readyState === 1 && B.ws.readyState === 1, 'readyState=' + A.ws.readyState);

/* 5. 房間不存在 / 房間已滿 */
const C = conn();
await C.open();
C.send({ t: 'join', code: 'ZZZZ', name: '路人' });
const err1 = await C.take((m) => m.t === 'err');
ok('加入不存在的房間會回錯', err1.msg === 'no such room', JSON.stringify(err1));
C.close();

const D = conn();
await D.open();
D.send({ t: 'join', code: CODE, name: '第三者' });
const err2 = await D.take((m) => m.t === 'err');
ok('房間已滿會回錯', err2.msg === 'room full', JSON.stringify(err2));
D.close();

/* 6. 對手離線 */
B.close();
const peerOff = await A.take((m) => m.t === 'peer' && m.on === false);
ok('guest 離線後 host 收到通知', peerOff.on === false, JSON.stringify(peerOff));

A.close();
await sleep(200);

console.log(`\n通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
process.exit(fail ? 1 : 0);
