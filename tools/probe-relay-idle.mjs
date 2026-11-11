/**
 * 探針：只連線（什麼都不做），量「多快被伺服器切斷」。
 * 用法：node tools/probe-relay-idle.mjs ws://127.0.0.1:8891
 * 目的：驗證 server.mjs 的 sweeper 是否會把正常連線踢掉。
 */
import WebSocket from '../server/node_modules/ws/index.js';

const url = process.argv[2] || 'ws://127.0.0.1:8891';
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

const ws = new WebSocket(url);
ws.on('open', () => {
  console.log(el(), 'open');
  ws.send(JSON.stringify({ t: 'create', name: 'probe' }));
});
ws.on('message', (raw) => console.log(el(), 'msg', raw.toString().slice(0, 80)));
ws.on('ping', () => console.log(el(), 'ping ← server'));
ws.on('close', (code, reason) => {
  console.log(el(), 'CLOSE', code, String(reason));
  process.exit(0);
});
ws.on('error', (e) => console.log(el(), 'error', e.message));
setTimeout(() => { console.log(el(), 'still open (90s)'); process.exit(0); }, 90e3);
