/**
 * 房間保溫器：建立一個房間並保持連線，讓瀏覽器可以「加入」當 guest 測。
 * 用法：node tools/room-keeper.mjs ws://127.0.0.1:8893
 * 印出 CODE=XXXX 給測試腳本抓。
 */
const url = process.argv[2] || 'ws://127.0.0.1:8893';
let WebSocket;
try { ({ WebSocket } = await import('ws')); }
catch { ({ default: WebSocket } = await import('../server/node_modules/ws/index.js')); }

const ws = new WebSocket(url);
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'create', name: '機器人' }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'room') console.log('CODE=' + m.code);
  else if (m.t === 'peer') console.log('PEER=' + JSON.stringify(m));
  else if (m.t === 's') console.log('STATE=' + JSON.stringify(m.d).slice(0, 120));
});
ws.on('close', (c) => { console.log('CLOSE=' + c); process.exit(0); });
ws.on('error', (e) => { console.log('ERR=' + e.message); process.exit(1); });
setInterval(() => { try { ws.ping(); } catch (e) {} }, 20000);
