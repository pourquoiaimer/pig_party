/**
 * 排球比賽主機（S 模式：伺服器權威）
 *
 * 邏輯來源跟瀏覽器**完全同一份**：從 index.html 切出
 *   /* ===== VOLLEY 邏輯 BEGIN ... /* ===== VOLLEY 邏輯 END =====
 * 那一段，用 new Function 在 Node 裡執行（手法同 tests/volley.logic.test.mjs）。
 * 所以「改玩法」只要改 index.html 一處，兩邊一起變。
 *
 * 這支只做三件事：
 *   1. loadVolleyLogic()  找 index.html、切區塊、編譯；找不到就回 {ok:false, reason}（伺服器照常跑大廳中繼）
 *   2. newMatch()/stepMatch()  固定步長推進一場比賽
 *   3. snapshot()  只送「畫得出來」的欄位、浮點數四捨五入到 2 位（省流量是重點）
 *
 * 不在這裡做的事：定時器、廣播、房間生命週期 —— 那些留在 server.mjs，責任切乾淨。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 固定步長：30Hz。用累積時間補償，不要拿 setInterval 的間隔直接當 dt。 */
export const TICK_S = 1 / 30;
/** 單一 gs 封包的目標上限（bytes，UTF-8）。實測值見 server/README.md。 */
export const MAX_SNAPSHOT_BYTES = 220;

const BEGIN = '/* ===== VOLLEY 邏輯 BEGIN';
const END = '/* ===== VOLLEY 邏輯 END ===== */';

let L = null;             // 載入後的 { VOLLEY, vvCreate, vvStep, vvReset }
let INFO = { ok: false, reason: '尚未初始化' };

/** 從一份 HTML 切出邏輯區塊並編譯；失敗回 null 並附原因 */
function compileFrom(file) {
  const html = fs.readFileSync(file, 'utf8');
  const a = html.indexOf(BEGIN);
  const b = html.indexOf(END);
  if (a < 0 || b < 0 || b < a) return { err: '找不到 VOLLEY 邏輯標記' };
  const src = html.slice(a, b);
  let api;
  try {
    api = new Function(src + '\nreturn { VOLLEY, vvCreate, vvStep, vvReset };')();
  } catch (e) {
    return { err: '區塊編譯失敗：' + (e && e.message) };
  }
  if (!api || typeof api.vvCreate !== 'function' || typeof api.vvStep !== 'function')
    return { err: '區塊不完整（缺 vvCreate/vvStep）' };
  return { api, lines: src.split('\n').length };
}

/**
 * 載入排球邏輯。
 * 來源順序：server/index.html（部署時一起複製過去）→ ../index.html（本地開發）。
 * 兩者都沒有 → {ok:false, reason}；呼叫端只把排球功能停用，不要讓整個服務死掉。
 */
export function loadVolleyLogic() {
  const cands = [
    process.env.VOLLEY_HTML ? path.resolve(process.env.VOLLEY_HTML) : null,
    path.join(HERE, 'index.html'),
    path.join(HERE, '..', 'index.html'),
  ].filter(Boolean);

  const tried = [];
  for (const f of cands) {
    if (!fs.existsSync(f)) { tried.push(f + '（不存在）'); continue; }
    const r = compileFrom(f);
    if (r.err) { tried.push(f + '（' + r.err + '）'); continue; }
    L = r.api;
    INFO = { ok: true, source: f, lines: r.lines, winPts: r.api.VOLLEY.WIN_PTS };
    return INFO;
  }
  L = null;
  INFO = { ok: false, reason: tried.join('；') || '找不到 index.html' };
  return INFO;
}

/** 目前狀態（給 log / /health 用） */
export function volleyInfo() {
  return Object.assign({}, INFO, { loaded: !!(L && INFO.ok) });
}

/* ---------------- 圈叉（回合制，走同一套房間/廣播外殼） ---------------- */
const OX_BEGIN = '/* ===== OX 邏輯 BEGIN';
const OX_END = '/* ===== OX 邏輯 END ===== */';
let OXL = null;            // { OXG, oxCreate, oxCmd, oxLine }
let OXINFO = { ok: false, reason: '尚未初始化' };

function compileOx(file) {
  const html = fs.readFileSync(file, 'utf8');
  const a = html.indexOf(OX_BEGIN);
  const b = html.indexOf(OX_END);
  if (a < 0 || b < 0 || b < a) return { err: '找不到 OX 邏輯標記' };
  const src = html.slice(a, b);
  let api;
  try {
    api = new Function(src + '\nreturn { OXG, oxCreate, oxCmd, oxLine };')();
  } catch (e) {
    return { err: '區塊編譯失敗：' + (e && e.message) };
  }
  if (!api || typeof api.oxCreate !== 'function' || typeof api.oxCmd !== 'function')
    return { err: '區塊不完整（缺 oxCreate/oxCmd）' };
  return { api, lines: src.split('\n').length };
}

/** 載入圈叉邏輯（來源順序同排球）。失敗只停用圈叉。 */
export function loadOxLogic() {
  const cands = [
    process.env.VOLLEY_HTML ? path.resolve(process.env.VOLLEY_HTML) : null,
    path.join(HERE, 'index.html'),
    path.join(HERE, '..', 'index.html'),
  ].filter(Boolean);
  const tried = [];
  for (const f of cands) {
    if (!fs.existsSync(f)) { tried.push(f + '（不存在）'); continue; }
    const r = compileOx(f);
    if (r.err) { tried.push(f + '（' + r.err + '）'); continue; }
    OXL = r.api;
    OXINFO = { ok: true, source: f, lines: r.lines };
    return OXINFO;
  }
  OXL = null;
  OXINFO = { ok: false, reason: tried.join('；') || '找不到 index.html' };
  return OXINFO;
}

export function oxInfo() {
  return Object.assign({}, OXINFO, { loaded: !!(OXL && OXINFO.ok) });
}

export function isOxReady() { return !!(OXL && OXINFO.ok); }

/* ---------------- 拔河（狂按，無物理；每人 20 次/秒上限） ---------------- */
const TUG_MAX = 230, TUG_STEP = 7, TUG_RATE = 20;

export function newTugMatch() {
  return {
    game: 'tug', r: 0, over: false, winner: -1, k: 0, lastBc: 0, lastPullAt: 0,
    overSent: false, dropped: 0, lastBytes: 0,
    rate: [{ n: 0, win: 0 }, { n: 0, win: 0 }],
    startedAt: Date.now(),
  };
}

/** 一次按下算一次；同一秒超過 20 次丟棄（腳本／連點器直接贏不了） */
export function tugPull(m, p) {
  if (!m || m.game !== 'tug') return { ok: false };
  if (p !== 0 && p !== 1) return { ok: false };
  if (m.over) return { ok: false };
  const t = Date.now();
  const slot = m.rate[p];
  if (t - slot.win >= 1000) { slot.win = t; slot.n = 0; }
  slot.n++;
  if (slot.n > TUG_RATE) { m.dropped++; return { ok: false, dropped: true }; }
  m.r += p === 0 ? -TUG_STEP : TUG_STEP;
  if (m.r <= -TUG_MAX) { m.r = -TUG_MAX; m.over = true; m.winner = 0; }
  else if (m.r >= TUG_MAX) { m.r = TUG_MAX; m.over = true; m.winner = 1; }
  return { ok: true, ev: [{ t: 'pull', p }] };
}

export function tugSnapshot(m, ev) {
  return { t: 'gs', k: m.k, s: { r: m.r | 0, ov: m.over ? 1 : 0, win: m.winner | 0 }, ev: ev || [] };
}

const E2048_START = 'const G_SIZE = 4;';
const E2048_END = '====== 2048 引擎 END ======';
let L2048 = null;
let INFO2048 = { ok: false, reason: '尚未初始化' };

function compile2048(file) {
  const html = fs.readFileSync(file, 'utf8');
  const a = html.indexOf(E2048_START);
  let b = html.indexOf(E2048_END, a);
  if (a < 0 || b < 0) return { err: '找不到 2048 引擎標記' };
  if (html.lastIndexOf('/*', b) > html.lastIndexOf('*/', b)) b = html.lastIndexOf('/*', b);   // 切在註解前
  const src = html.slice(a, b);
  let api;
  try { api = new Function(src + '\nreturn { gNew, gStep, gCanMove };')(); }
  catch (e) { return { err: '引擎編譯失敗：' + (e && e.message) }; }
  if (!api || typeof api.gNew !== 'function' || typeof api.gStep !== 'function')
    return { err: '引擎不完整（缺 gNew/gStep）' };
  return { api, lines: src.split('\n').length };
}

export function load2048Logic() {
  const cands = [
    process.env.VOLLEY_HTML ? path.resolve(process.env.VOLLEY_HTML) : null,
    path.join(HERE, 'index.html'),
    path.join(HERE, '..', 'index.html'),
  ].filter(Boolean);
  const tried = [];
  for (const f of cands) {
    if (!fs.existsSync(f)) { tried.push(f + '（不存在）'); continue; }
    const r = compile2048(f);
    if (r.err) { tried.push(f + '（' + r.err + '）'); continue; }
    L2048 = r.api;
    INFO2048 = { ok: true, source: f, lines: r.lines };
    return INFO2048;
  }
  L2048 = null;
  INFO2048 = { ok: false, reason: tried.join('；') || '找不到 index.html' };
  return INFO2048;
}

export function info2048() { return Object.assign({}, INFO2048, { loaded: !!(L2048 && INFO2048.ok) }); }

/** 一次移動一格的 rng（伺服器洗牌） */
function srvRng() { return Math.random(); }

export function newMatch2048() {
  if (!L2048) throw new Error('2048 引擎未載入');
  return {
    game: '2048',
    // 兩邊各自的盤：{ grid, score, moves, over }
    g: [L2048.gNew(srvRng), L2048.gNew(srvRng)],
    k: 0, lastBc: 0, over: false, winner: -1, overSent: false, lastBytes: 0,
    startedAt: Date.now(),
  };
}

/** p 只能動自己的盤；死局後忽略 */
export function command2048(m, p, dir) {
  if (!m || m.game !== '2048') return { ok: false, ev: [] };
  if (p !== 0 && p !== 1) return { ok: false, ev: [] };
  if (!['left', 'right', 'up', 'down'].includes(dir)) return { ok: false, ev: [] };
  const game = m.g[p];
  if (game.over) return { ok: false, ev: [] };
  const res = L2048.gStep(game, dir, srvRng);
  if (!res.moved) return { ok: false, ev: [] };
  m.over = m.g[0].over && m.g[1].over;
  return { ok: true, ev: [{ t: 'moved', p, gain: res.gained | 0 }] };
}

export function snapshot2048(m, ev) {
  return {
    t: 'gs', k: m.k,
    s: { g: [m.g[0].grid.slice(), m.g[1].grid.slice()],
         sc: [m.g[0].score | 0, m.g[1].score | 0],
         dd: [m.g[0].over ? 1 : 0, m.g[1].over ? 1 : 0] },
    ev: ev || [],
  };
}

const MEM_BEGIN = '/* ===== MEMORY 邏輯 BEGIN';
const MEM_END = '/* ===== MEMORY 邏輯 END ===== */';
let MEML = null;
let MEMINFO = { ok: false, reason: '尚未初始化' };

function compileMemory(file) {
  const html = fs.readFileSync(file, 'utf8');
  const a = html.indexOf(MEM_BEGIN), b = html.indexOf(MEM_END);
  if (a < 0 || b < 0 || b < a) return { err: '找不到 MEMORY 邏輯標記' };
  const src = html.slice(a, b);
  let api;
  try { api = new Function(src + '\nreturn { MEM, memCreate, memCmd, memTick };')(); }
  catch (e) { return { err: '區塊編譯失敗：' + (e && e.message) }; }
  if (!api || typeof api.memCreate !== 'function' || typeof api.memCmd !== 'function' || typeof api.memTick !== 'function')
    return { err: '區塊不完整（缺 memCreate/memCmd/memTick）' };
  return { api, lines: src.split('\n').length };
}

export function loadMemoryLogic() {
  const cands = [
    process.env.VOLLEY_HTML ? path.resolve(process.env.VOLLEY_HTML) : null,
    path.join(HERE, 'index.html'),
    path.join(HERE, '..', 'index.html'),
  ].filter(Boolean);
  const tried = [];
  for (const f of cands) {
    if (!fs.existsSync(f)) { tried.push(f + '（不存在）'); continue; }
    const r = compileMemory(f);
    if (r.err) { tried.push(f + '（' + r.err + '）'); continue; }
    MEML = r.api;
    MEMINFO = { ok: true, source: f, lines: r.lines };
    return MEMINFO;
  }
  MEML = null;
  MEMINFO = { ok: false, reason: tried.join('；') || '找不到 index.html' };
  return MEMINFO;
}

export function memInfo() {
  return Object.assign({}, MEMINFO, { loaded: !!(MEML && MEMINFO.ok) });
}

export function newMemoryMatch(seed) {
  if (!MEML) throw new Error('翻牌邏輯未載入');
  return {
    game: 'memory', S: MEML.memCreate(seed === undefined ? ((Math.random() * 1e9) | 0) : seed),
    k: 0, lastBc: 0, lastTick: 0, over: false, winner: -1, overSent: false, lastBytes: 0,
    startedAt: Date.now(),
  };
}

/** 執行一個翻牌指令（回合鎖在 memCmd 裡） */
export function memCommand(m, p, cmd) {
  if (!m || m.game !== 'memory') return { ok: false, ev: [], why: 'no-match' };
  return MEML.memCmd(m.S, p, cmd);
}

/** 10Hz 推進計時器（配對 1.0 秒、配錯 0.8 秒） */
export function memTickMatch(m, dt) {
  if (!m || m.game !== 'memory') return [];
  const ev = MEML.memTick(m.S, dt);
  if (m.S.over) { m.over = true; m.winner = m.S.winner; }
  return ev;
}

/** 翻牌快照：牌堆用字串送（16 字元），比陣列省一半以上 */
export function memSnapshot(m, ev) {
  const S = m.S;
  return {
    t: 'gs', k: m.k,
    s: {
      d: S.deck.join(''), f: S.flip.join(''), g: S.gone.join(''),
      c: [[S.cur[0].x | 0, S.cur[0].y | 0], [S.cur[1].x | 0, S.cur[1].y | 0]],
      sc: [S.sc[0] | 0, S.sc[1] | 0], tn: S.turn | 0, lk: S.lock ? 1 : 0,
      mt: [S.first | 0, S.second | 0], ov: S.over ? 1 : 0, win: S.winner | 0, mv: S.moves | 0,
    },
    ev: (ev || []).map((e) => (e.i === undefined ? { t: e.t, p: e.p } : { t: e.t, p: e.p, i: e.i })),
  };
}
export function newOxMatch() {
  if (!OXL) throw new Error('圈叉邏輯未載入');
  return {
    game: 'ox',
    S: OXL.oxCreate(),
    startedAt: Date.now(),
    over: false,
    winner: -1,
    k: 0,                   // 廣播序號（前端用它判斷新舊）
    lastBc: 0,              // 上次廣播時間（心跳用）
    overSent: false,
    lastBytes: 0,
  };
}

/** 執行一個圈叉指令（回合鎖在 oxCmd 裡）。回傳 {ok, ev, why} */
export function oxCommand(m, p, cmd) {
  if (!m || m.game !== 'ox') return { ok: false, ev: [], why: 'no-match' };
  const res = OXL.oxCmd(m.S, p, cmd);
  if (res.ok && m.S.over) { m.over = true; m.winner = m.S.winner; }
  return res;
}

/** 圈叉快照：只送棋盤需要的欄位（約 100 bytes） */
export function oxSnapshot(m, ev) {
  const S = m.S;
  return {
    t: 'gs',
    k: m.k,
    s: {
      b: S.board.slice(),
      h: [S.hand[0] | 0, S.hand[1] | 0],
      tn: S.turn | 0,
      cur: S.cursor | 0,
      hd: S.held,
      ov: S.over ? 1 : 0,
      win: S.winner | 0,
      mv: S.moves | 0,
      dr: S.draw ? 1 : 0,
      wl: S.winLine ? S.winLine.slice() : null,
    },
    ev: (ev && ev.length ? ev : []).map(e => (e.i === undefined ? { t: e.t, p: e.p } : { t: e.t, p: e.p, i: e.i })),
  };
}

export function isReady() { return !!(L && INFO.ok); }

/** 新的一場（index 0 = host、1 = guest） */
export function newMatch() {
  if (!L) throw new Error('排球邏輯未載入');
  return {
    game: 'volley',
    S: L.vvCreate(),
    inputs: [{ l: false, r: false, u: false }, { l: false, r: false, u: false }],
    startedAt: Date.now(),
    over: false,
    winner: -1,
    k: 0,          // tick 序號（前端用它判斷新舊封包）
    acc: 0,        // 累積時間（秒）
    lastMs: Date.now(),
    lastBytes: 0,
  };
}

/** 設定某一邊的輸入（只作用在自己的 index） */
export function setInput(m, idx, i) {
  if (!m || (idx !== 0 && idx !== 1)) return;
  const v = i || {};
  m.inputs[idx] = { l: v.l ? 1 : 0, r: v.r ? 1 : 0, u: v.u ? 1 : 0 };
}

/** 推進一個固定步長，回傳這一 tick 的事件陣列 */
export function stepMatch(m, dt) {
  const i = m.inputs;
  const ev = L.vvStep(m.S, [
    { l: !!i[0].l, r: !!i[0].r, u: !!i[0].u },
    { l: !!i[1].l, r: !!i[1].r, u: !!i[1].u },
  ], dt);
  if (m.S.over) { m.over = true; m.winner = m.S.winner; }
  return ev;
}

const r2 = (v) => {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  return Object.is(n, -0) ? 0 : n;
};

/**
 * 狀態快照。**不要**整包 JSON.stringify(S)（997 bytes → 30Hz 兩人 ≈ 60KB/s）。
 * 只送畫得出來的欄位，浮點數 2 位；訊息只在真的要顯示時才帶（省 bytes）。
 */
export function snapshot(m, ev) {
  const S = m.S;
  const showMsg = (S.msgT > 0 || S.over);
  return {
    t: 'gs',
    k: m.k,
    s: {
      p: [[r2(S.P[0].x), r2(S.P[0].y)], [r2(S.P[1].x), r2(S.P[1].y)]],
      b: [r2(S.ball.x), r2(S.ball.y)],
      /* bv（球速）**不送**：canvas 的 drawBall 只用 x/y/trail/cool，vx/vy 一格都沒用到，
         實測省 14 bytes，讓最壞情況（得分那一 tick ＋ 4 位數 tick 序號）仍遠低於 220。
         之後若要做用戶端預測再把它加回來。 */
      live: S.ball.live ? 1 : 0,
      cool: r2(S.ball.cool),
      sc: [S.score[0] | 0, S.score[1] | 0],
      ov: S.over ? 1 : 0,
      win: S.winner | 0,
      st: r2(Math.max(0, S.serveT)),
      ms: showMsg ? String(S.msg || '').slice(0, 40) : '',
      mt: r2(S.msgT),
      ra: S.rally | 0,
      sh: Math.round(S.shake),
      fa: r2(S.flashA),
    },
    /* 事件只送 {t,p}：server 欄位（下一位發球者）前端可由 sc/球位置推得，
       少這 11 bytes 讓「得分＋訊息＋事件」那一 tick 也能壓在 220 以內。
       最後一分同時有 point + win → 只留 win（比分已經在 s.sc，前端播一次音就好），
       否則那一包會到 242 bytes。 */
    ev: (() => {
      if (!ev || !ev.length) return [];
      const hasWin = ev.some((e) => e.t === 'win');
      return ev.filter((e) => !(hasWin && e.t === 'point')).map((e) => ({ t: e.t, p: e.p }));
    })(),
  };
}

/** 量封包大小（bytes，UTF-8）—— health 與測試用 */
export function snapshotBytes(m, ev) {
  return Buffer.byteLength(JSON.stringify(snapshot(m, ev)));
}
