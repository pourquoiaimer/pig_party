/** 假對手：用 node 當第二個玩家，讓單一瀏覽器就能完成連線驗收。
 *  用法：node tools/fake-opponent.mjs <PORT> <房間碼> [腳本]
 *  腳本範例：'d:10' = 按 d 十次；'wait:2000' = 等 2 秒
 *  輸出：每一包 gs 的 k 與 s（JSON），方便用 grep 取證
 */
import path from 'node:path';
const PORT = process.argv[2] || '8897';
const CODE = (process.argv[3] || '').toUpperCase();
const SCRIPT = process.argv[4] || '';

let WebSocket;
try { ({ WebSocket } = await import('ws')); }
catch { ({ default: WebSocket } = await import('../server/node_modules/ws/index.js')); }

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let started = false;

ws.on('open', () => {
  console.log('[opp] connected');
  ws.send(JSON.stringify({ t: 'join', code: CODE, name: '假對手' }));
});
ws.on('message', async (buf) => {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  if (m.t === 'joined' || m.t === 'room') console.log('[opp] room', JSON.stringify(m).slice(0, 120));
  if (m.t === 'gstart') {
    started = true;
    console.log('[opp] GSTART', JSON.stringify(m).slice(0, 160));
    if (SCRIPT) runScript();
  }
  if (m.t === 'gs') console.log('[opp] gs', JSON.stringify(m.s));
  if (m.t === 'gend') console.log('[opp] GEND', JSON.stringify(m));
});
ws.on('error', (e) => console.log('[opp] error', e.message));

async function runScript() {
  for (const step of SCRIPT.split(',')) {
    const [act, arg] = step.split(':');
    if (act === 'wait') { await sleep(Number(arg) || 500); continue; }
    const n = Number(arg) || 1;
    for (let i = 0; i < n; i++) {
      ws.send(JSON.stringify({ t: act === 'ri' || act === 'd' || act === 'u' ? 'ri' : act, d: act === 'u' ? 'up' : 'right' }));
      await sleep(90);
    }
  }
}
setTimeout(() => { console.log('[opp] done'); process.exit(0); }, 22000);
