/**
 * 房間成本基準測試：模擬「伺服器權威」模式下，一間房每秒要花多少 CPU／記憶體。
 *
 * 用途：回答「把遊戲計算搬到後端，常駐會不會吃掉 VPS 資源」。
 * 跑法：node server/bench-room.mjs [房間數] [秒數]
 *   node server/bench-room.mjs 10 10
 *
 * 模擬的工作量（故意抓得比實際重）：
 *   · 30Hz 固定步長
 *   · 2 位玩家：輸入 → 位置積分 → 邊界碰撞
 *   · 一顆球的拋物線物理 + 落地判定 + 得分重置
 *   · 每 tick 產生要廣播給 2 位玩家的狀態快照（JSON 序列化，最貴的做法）
 */
const ROOMS = Number(process.argv[2] || 10);
const SECONDS = Number(process.argv[3] || 10);
const HZ = 30;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function makeRoom(id) {
  return {
    id,
    tick: 0,
    score: [0, 0],
    players: [
      { x: -4, y: 0, vy: 0 },
      { x: 4, y: 0, vy: 0 },
    ],
    ball: { x: 0, y: 3, vx: 2.5, vy: 1.2, r: 0.35 },
    input: [{ left: false, right: true, act: false }, { left: true, right: false, act: false }],
  };
}

/** 一個 tick 的模擬（＝未來伺服器上會跑的東西） */
function stepRoom(r, dt) {
  r.tick++;
  // 玩家移動（2 人）
  for (let i = 0; i < 2; i++) {
    const p = r.players[i], inp = r.input[i];
    const dirX = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    p.x = clamp(p.x + dirX * 6 * dt, -8, 8);
    // 跳躍
    if (inp.act && p.y <= 0) p.vy = 7;
    p.vy -= 18 * dt;
    p.y = Math.max(0, p.y + p.vy * dt);
    if (p.y === 0) p.vy = 0;
    // 假造一些輸入變化，讓分支真的被執行到
    if (r.tick % 17 === i) inp.left = !inp.left;
    if (r.tick % 23 === i) inp.right = !inp.right;
    if (r.tick % 31 === i) inp.act = !inp.act;
  }
  // 球物理
  const b = r.ball;
  b.vy -= 9.8 * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  if (b.x < -8 || b.x > 8) { b.vx *= -1; b.x = clamp(b.x, -8, 8); }
  if (b.y < 0) { b.y = 3; b.vy = 1.2; r.score[r.tick % 2]++; }
  // 球與玩家碰撞（AABB 近似）
  for (const p of r.players) {
    if (Math.abs(b.x - p.x) < 0.6 && Math.abs(b.y - (p.y + 0.9)) < 0.9) { b.vy = 6; b.vx = -b.vx; }
  }
}

/** 每 tick 要送給 2 位玩家的狀態快照（JSON = 最貴；之後可換二進位） */
function snapshot(r) {
  return JSON.stringify({
    t: 'st',
    k: r.tick,
    s: r.score,
    p: r.players.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)]),
    b: [+r.ball.x.toFixed(3), +r.ball.y.toFixed(3)],
  });
}

const rooms = Array.from({ length: ROOMS }, (_, i) => makeRoom(i));
const dt = 1 / HZ;
let bytes = 0, ticks = 0, snaps = 0;

const cpu0 = process.cpuUsage();
const wall0 = Date.now();
const mem0 = process.memoryUsage().rss;

const timer = setInterval(() => {
  const t0 = process.hrtime.bigint();
  for (const r of rooms) {
    stepRoom(r, dt);
    bytes += snapshot(r).length * 2;   // ×2 = 送給兩位玩家
    snaps++;
  }
  ticks++;
  const t1 = process.hrtime.bigint();
  tickNsTotal += Number(t1 - t0);
}, 1000 / HZ);
let tickNsTotal = 0;

setTimeout(() => {
  clearInterval(timer);
  const cpu = process.cpuUsage(cpu0);
  const wallMs = Date.now() - wall0;
  const mem1 = process.memoryUsage().rss;
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const cpuPct = (cpuMs / wallMs) * 100;

  console.log(JSON.stringify({
    rooms: ROOMS,
    seconds: +(wallMs / 1000).toFixed(1),
    ticks,
    snapshots: snaps,
    cpuMs: +cpuMs.toFixed(1),
    cpuPctOfOneCore: +cpuPct.toFixed(2),
    avgTickMs: +(tickNsTotal / ticks / 1e6).toFixed(4),
    rssMB: +(mem1 / 1048576).toFixed(1),
    rssGrowthMB: +((mem1 - mem0) / 1048576).toFixed(1),
    perRoomRssKB: +(((mem1 - mem0) / ROOMS) / 1024).toFixed(1),
    broadcastMBps: +((bytes / (wallMs / 1000)) / 1048576).toFixed(3),
    perRoomBroadcastKBps: +((bytes / (wallMs / 1000) / ROOMS) / 1024).toFixed(1),
  }, null, 2));
}, SECONDS * 1000);
