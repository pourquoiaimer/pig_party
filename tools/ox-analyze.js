/* ==========================================================================
   OX（可移動的圈叉）規則分析器 —— 開發用的分析工具，不是遊戲本體。

   規則：
     3x3 棋盤、每人 N 顆棋子。
     輪到你時可以：(a) 放一顆新棋子到空格  (b) 把「自己的」棋子移到空格
     三連線者勝。

   為什麼需要這支程式：
     這遊戲有「循環」（雙方可以一直滑來滑去不結束），一般 minimax 會撞到
     無限遞迴。這裡用標準的「回溯分析 / 固定點法」：
        WIN  = 存在一步走到對手的 LOSS
        LOSS = 所有步都走到對手的 WIN
        反覆迭代到不動點；最後仍未定的局面 = DRAW（雙方都無法強制取勝，
        但都能避免輸 → 依慣例算和局）

   為什麼要有自我檢查：
     第一版的測試案例 hx/ho 與盤面不一致（那種局面根本不存在），
     會得到假的 FAIL。這裡改成：
       (1) 手挑的合法局面（不合法會標 SKIP 而不是 FAIL）
       (2) 全域一致性掃描：每個 WIN 必須真的存在一步到 LOSS、
           每個 LOSS 的所有步必須真的都到 WIN、DRAW 不得有到 LOSS 的步
     解算器本身不對的話，後面所有數字都不能信。

   用法： node tools/ox-analyze.js [N...]
   ========================================================================== */

const SIZE = 3, CELLS = SIZE * SIZE;
const LINES = [];
for (let r = 0; r < SIZE; r++) LINES.push([0, 1, 2].map(c => r * SIZE + c));
for (let c = 0; c < SIZE; c++) LINES.push([0, 1, 2].map(r => r * SIZE + c));
LINES.push([0, 4, 8], [2, 4, 6]);

const EMPTY = 0, X = 1, O = 2;
const UNK = 0, WIN = 1, LOSS = 2, DRAW = 3;
const RN = ['未定', 'WIN', 'LOSS', 'DRAW'];
const NAME = { 1: '先手必勝', 2: '先手必敗（後手必勝）', 3: '和局（雙方都無法強制取勝）', 0: '未定' };

function lineOwner(b) {
  for (const L of LINES) {
    const v = b[L[0]];
    if (v !== EMPTY && v === b[L[1]] && v === b[L[2]]) return v;
  }
  return 0;
}
function packBoard(b) {
  let k = 0;
  for (let i = CELLS - 1; i >= 0; i--) k = k * 3 + b[i];
  return k;
}
function unpack(bk, b) {
  let v = bk;
  for (let i = 0; i < CELLS; i++) { b[i] = v % 3; v = (v / 3) | 0; }
}
function neighbours(i) {
  const r = (i / SIZE) | 0, c = i % SIZE, out = [];
  if (r > 0) out.push(i - SIZE);
  if (r < SIZE - 1) out.push(i + SIZE);
  if (c > 0) out.push(i - 1);
  if (c < SIZE - 1) out.push(i + 1);
  return out;
}
const keyOf = (N) => {
  const M = N + 1;
  return (bk, hx, ho, t) => ((bk * M + hx) * M + ho) * 2 + t;
};
const parseKey = (k, N) => {
  const M = N + 1, t = k % 2;
  let r = (k - t) / 2;
  const ho = r % M; r = (r - ho) / M;
  const hx = r % M; const bk = (r - hx) / M;
  return { bk, hx, ho, t };
};

/** 局面 k 的所有合法後繼（放新子 ＋ 移動己方棋子）寫進 out，回傳數量。
 *  只有這一份走法邏輯 —— 解算器與自我檢查共用，避免兩份走鐘。 */
function succKeys(k, N, adjacent, out) {
  const { bk, hx, ho, t } = parseKey(k, N);
  const M = N + 1;
  const b = new Array(CELLS);
  unpack(bk, b);
  const me = t === 0 ? X : O;
  const myHand = t === 0 ? hx : ho;
  const NH = t === 0 ? hx - 1 : hx, NHo = t === 0 ? ho : ho - 1, nt = 1 - t;
  let n = 0;
  if (myHand > 0) {
    for (let i = 0; i < CELLS; i++) {
      if (b[i] !== EMPTY) continue;
      b[i] = me;
      out[n++] = ((packBoard(b) * M + NH) * M + NHo) * 2 + nt;
      b[i] = EMPTY;
    }
  }
  for (let i = 0; i < CELLS; i++) {
    if (b[i] !== me) continue;
    for (let j = 0; j < CELLS; j++) {
      if (b[j] !== EMPTY) continue;
      if (adjacent && !neighbours(i).includes(j)) continue;
      b[i] = EMPTY; b[j] = me;
      out[n++] = ((packBoard(b) * M + hx) * M + ho) * 2 + nt;
      b[j] = EMPTY; b[i] = me;
    }
  }
  return n;
}

/* ---------------- 精確解 ---------------- */
function solve(N, adjacent) {
  const M = N + 1;
  const key = keyOf(N);
  const res = new Uint8Array(Math.pow(3, CELLS) * M * M * 2);
  const b = new Array(CELLS);
  const states = [];

  for (let bk = 0; bk < Math.pow(3, CELLS); bk++) {
    unpack(bk, b);
    let bx = 0, bo = 0;
    for (const v of b) { if (v === X) bx++; else if (v === O) bo++; }
    if (bx > N || bo > N) continue;
    const hx = N - bx, ho = N - bo;              // 棋子總數守恆 → 手牌由盤面決定
    const terminal = !!lineOwner(b);
    // ⚠️ 不能再用「hx === ho 就是 X 的回合」來推論回合！
    //    那只有在「雙方都只放子」時才成立。移動棋子不消耗手牌，
    //    所以同一個盤面的兩種回合都合法（第一版就是這裡錯，害所有結果都變和局）。
    for (const t of [0, 1]) {
      const k = key(bk, hx, ho, t);
      states.push(k);
      if (terminal) res[k] = LOSS;               // 有人連線 → 輪到的人輸
    }
  }
  const uniq = [...new Set(states)];

  let iter = 0;
  const buf = new Int32Array(64);
  for (;;) {
    iter++;
    let changed = false;
    for (const k of uniq) {
      if (res[k] !== UNK) continue;
      const n = succKeys(k, N, adjacent, buf);
      if (n === 0) { res[k] = DRAW; changed = true; continue; }
      let anyLoss = false, allWin = true, anyUnk = false;
      for (let i = 0; i < n; i++) {
        const v = res[buf[i]];
        if (v === LOSS) anyLoss = true;
        if (v !== WIN) allWin = false;
        if (v === UNK) anyUnk = true;
      }
      if (anyLoss)      { res[k] = WIN;  changed = true; }
      else if (allWin)  { res[k] = LOSS; changed = true; }
      else if (!anyUnk) { res[k] = DRAW; changed = true; }
    }
    if (!changed) break;
  }
  let cycles = 0;
  for (const k of uniq) if (res[k] === UNK) { res[k] = DRAW; cycles++; }

  return { N, adjacent, res, uniq, key, iter, cycles,
           start: key(packBoard(new Array(CELLS).fill(EMPTY)), N, N, 0) };
}

/* ---------------- 自我檢查 ---------------- */
function selfTest() {
  const N = 3, r = solve(N, false), key = r.key;
  const cases = [];
  const mk = (pieces, hx, ho, t, want, why) => {
    const board = new Array(CELLS).fill(EMPTY);
    for (const [i, v] of pieces) board[i] = v;
    const bx = pieces.filter(p => p[1] === X).length, bo = pieces.filter(p => p[1] === O).length;
    const legal = (bx + hx === N) && (bo + ho === N);   // 回合不需要一致性檢查
    if (!legal) { cases.push({ why, ok: 'SKIP', note: '局面不合法（hx/ho 與盤面不符）' }); return; }
    const got = r.res[key(packBoard(board), hx, ho, t)];
    cases.push({ why, want, got, ok: got === want ? 'PASS' : 'FAIL' });
  };
  mk([[0, X], [1, X], [3, O], [4, O]], 1, 1, 0, WIN, 'X 兩連線＋手上一顆、輪到 X → 放到中間格就贏');
  mk([[0, X], [1, X], [2, X], [3, O], [4, O]], 0, 1, 1, LOSS, 'X 已連線的終局，輪到 O → O 輸');
  mk([[0, X], [1, X], [5, X], [3, O], [4, O], [7, O]], 0, 0, 0, WIN, 'X 沒手牌但可移子湊成連線 → WIN');

  console.log('\n──── 解算器自我檢查 ────');
  for (const c of cases)
    console.log(`  [${c.ok}] ${c.why}` + (c.note ? `\n        （${c.note}）`
      : `\n        期望 ${RN[c.want]} / 實得 ${RN[c.got]}`));

  // 全域一致性掃描（終局局面本來就直接標 LOSS，不適用一致性條件，要跳過）
  const buf = new Int32Array(128);
  const bb = new Array(CELLS);
  let bad = 0, checked = 0;
  for (const k of r.uniq) {
    unpack(parseKey(k, N).bk, bb);
    if (lineOwner(bb)) continue;
    checked++;
    const n = succKeys(k, N, false, buf);
    let anyLoss = false, allWin = true;
    for (let i = 0; i < n; i++) { const v = r.res[buf[i]]; if (v === LOSS) anyLoss = true; if (v !== WIN) allWin = false; }
    if (r.res[k] === WIN && !anyLoss) bad++;
    if (r.res[k] === LOSS && !allWin) bad++;
    if (r.res[k] === DRAW && anyLoss) bad++;
  }
  console.log(`  全域一致性掃描：${checked} 個非終局局面 → ${bad === 0 ? '✅ 完全一致' : `❌ ${bad} 個不一致`}`);

  const ok = cases.every(c => c.ok !== 'FAIL') && bad === 0;
  console.log(ok ? '  ✅ 解算器可信' : '  ❌ 解算器有問題 —— 下面的結論不可信！');
  return ok;
}

/* ---------------- 亂玩模擬 ---------------- */
function playRandom(N, adjacent, rng, maxMoves) {
  const b = new Array(CELLS).fill(EMPTY);
  let hx = N, ho = N, t = 0, mv = 0;
  while (mv < maxMoves) {
    const me = t === 0 ? X : O;
    const hand = t === 0 ? hx : ho;
    const opts = [];
    if (hand > 0) for (let i = 0; i < CELLS; i++) if (b[i] === EMPTY) opts.push(['p', i, -1]);
    for (let i = 0; i < CELLS; i++) {
      if (b[i] !== me) continue;
      for (let j = 0; j < CELLS; j++) {
        if (b[j] !== EMPTY) continue;
        if (adjacent && !neighbours(i).includes(j)) continue;
        opts.push(['m', j, i]);
      }
    }
    if (!opts.length) return { winner: 0, mv };
    const pick = opts[(rng() * opts.length) | 0];
    if (pick[0] === 'p') { b[pick[1]] = me; if (t === 0) hx--; else ho--; }
    else { b[pick[2]] = EMPTY; b[pick[1]] = me; }
    mv++;
    const ow = lineOwner(b);
    if (ow) return { winner: ow, mv };
    t = 1 - t;
  }
  return { winner: 0, mv };
}

/* -------------------------------------------------------------------------- */
let seed = 12345;
const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const args = process.argv.slice(2).map(Number).filter(n => n > 0);
const list = args.length ? args : [3, 4, 5];

if (!selfTest()) process.exit(1);   // 解算器本身不對的話，後面所有結論都不能信

for (const N of list) {
  for (const adjacent of [false, true]) {
    const t0 = Date.now();
    const r = solve(N, adjacent);
    const cnt = { 1: 0, 2: 0, 3: 0 };
    for (const k of r.uniq) cnt[r.res[k]]++;
    const b0 = new Array(CELLS).fill(EMPTY);
    const firsts = [];
    for (let i = 0; i < CELLS; i++) {
      b0[i] = X;
      firsts.push(`${i}→${RN[r.res[r.key(packBoard(b0), N - 1, N, 1)]]}`);
      b0[i] = EMPTY;
    }
    seed = 987654321;
    let dec = 0, sum = 0;
    const T = 3000;
    for (let i = 0; i < T; i++) { const g = playRandom(N, adjacent, rng, 200); sum += g.mv; if (g.winner) dec++; }

    console.log(`\n══════ 每人 ${N} 顆　移動：${adjacent ? '只能移到相鄰格' : '可移到任意空格'} ══════`);
    console.log(`  棋盤上最多 ${Math.min(9, 2 * N)} 顆（9 格）、空格 ${Math.max(0, 9 - 2 * N)} 個　·　合法局面 ${r.uniq.length.toLocaleString()}（循環和局 ${r.cycles}）`);
    console.log(`  完美對戰：${NAME[r.res[r.start]]}`);
    console.log(`  局面統計：WIN ${cnt[1]} / LOSS ${cnt[2]} / DRAW ${cnt[3]}`);
    console.log(`  先手第一步：${firsts.join('  ')}`);
    console.log(`  亂玩 ${T} 場：分出勝負 ${(dec / T * 100).toFixed(1)}%　平均 ${(sum / T).toFixed(1)} 步`);
    console.log(`  （迭代 ${r.iter} 輪，耗時 ${Date.now() - t0} ms）`);
  }
}
