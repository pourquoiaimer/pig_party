/**
 * 圈叉「純邏輯」測試（07）
 * 手法同 tests/volley.logic.test.mjs：切出 index.html 的 OX 邏輯區塊在 Node 跑。
 * 執行：node tests/ox.logic.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== OX 邏輯 BEGIN');
const b = html.indexOf('/* ===== OX 邏輯 END ===== */');
if (a < 0 || b < 0) throw new Error('找不到 OX 邏輯區塊標記');
const src = html.slice(a, b);
const O = new Function(src + '\nreturn { OXG, oxCreate, oxCmd, oxLine };')();
const { OXG, oxCreate, oxCmd, oxLine } = O;

let pass = 0, fail = 0;
const res = [];
function ok(name, cond, extra) {
  if (cond) { pass++; res.push('  ✓ ' + name); }
  else { fail++; res.push('  ✗ ' + name + (extra ? '   → ' + extra : '')); }
}
const snap = (S) => JSON.stringify(S);
const mv = (S, p, d) => oxCmd(S, p, { a: 'move', d });
const cf = (S, p) => oxCmd(S, p, { a: 'confirm' });
/** 把游標移到指定格（用 move 指令，順便驗證移動本身） */
function goTo(S, p, idx) {
  let guard = 0;
  while (S.cursor !== idx && guard++ < 20) {
    const r = Math.floor(S.cursor / 3), c = S.cursor % 3;
    const tr = Math.floor(idx / 3), tc = idx % 3;
    if (r < tr) mv(S, p, 'down'); else if (r > tr) mv(S, p, 'up');
    else if (c < tc) mv(S, p, 'right'); else mv(S, p, 'left');
  }
}
/** 在指定格下子（新棋子），回傳 oxCmd 結果 */
function dropAt(S, p, idx) { goTo(S, p, idx); return cf(S, p); }

/* ---------------- 0. 純度 ---------------- */
console.log('\n【0】邏輯區塊純度');
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const bad of ['document', 'window', 'blip', 'HELD', 'performance', 'Math.random', 'THREE'])
  ok(`不含 ${bad}`, !new RegExp('\\b' + bad.replace('.', '\\.') + '\\b').test(codeOnly));

/* ---------------- 1. 基本狀態 ---------------- */
console.log('\n【1】初始狀態');
{
  const S = oxCreate();
  ok('棋盤 9 格全空', S.board.length === 9 && S.board.every(v => v === 0));
  ok('手牌各 4 顆', S.hand[0] === 4 && S.hand[1] === 4);
  ok('P1 先手、游標在中間', S.turn === 0 && S.cursor === 4);
  ok('沒有勝負', S.over === false && S.winner === -1 && S.winLine === null);
}

/* ---------------- 2. 拿起／放下／取消 ---------------- */
console.log('\n【2】拿起／放下／取消');
{
  const S = oxCreate();
  let r = dropAt(S, 0, 4);
  ok('空格放下新棋子 → ok、drop 事件', r.ok && r.ev[0].t === 'drop' && r.ev[0].p === 0, JSON.stringify(r));
  ok('手牌 4 → 3', S.hand[0] === 3);
  ok('換手給 P2、游標回中間', S.turn === 1 && S.cursor === 4);

  dropAt(S, 1, 0);
  ok('P2 下在 0 號格', S.board[0] === 2 && S.hand[1] === 3);

  // P1 拿起自己的棋子（4 號格）
  r = goTo(S, 0, 4), r = cf(S, 0);
  ok('指向自己的棋子按確認 → 拿起', r.ok && r.ev[0].t === 'pick' && S.held === 4, JSON.stringify(r));
  ok('拿起後原格清空', S.board[4] === 0);
  ok('拿起不算換手', S.turn === 0 && S.moves === 2);

  // 放回同一格 = 取消
  r = cf(S, 0);
  ok('放回同一格 → cancel 事件、棋子回原位', r.ok && r.ev[0].t === 'cancel' && S.board[4] === 1 && S.held === -1);
  ok('取消不換手、不算步數', S.turn === 0 && S.moves === 2);

  // 拿起來再放到別的空格
  goTo(S, 0, 4); cf(S, 0);
  r = dropAt(S, 0, 8);
  ok('拿起後放到別的空格 → drop、原格保持空', r.ok && S.board[8] === 1 && S.board[4] === 0, JSON.stringify(S.board));
  ok('搬到別格也算一步', S.moves === 3 && S.turn === 1);
}

/* ---------------- 3. 手牌上限 ---------------- */
console.log('\n【3】手牌 4 顆用完');
{
  /* 直接把回合給 P1 連下 4 顆（0,1,3,4 不會三連），只驗「手牌計數」這件事 */
  const S = oxCreate();
  for (const c of [0, 1, 3, 4]) { S.turn = 0; S.cursor = c; cf(S, 0); }
  ok('連下 4 顆後手牌 0', S.hand[0] === 0, JSON.stringify(S.hand));
  ok('場上 4 顆、沒有誤判勝負', S.board.filter(v => v === 1).length === 4 && !S.over,
     JSON.stringify({ b: S.board, over: S.over }));
  // 現在輪到誰就用誰檢查（不保證是 P1）——直接檢查「手牌 0 的人不能再下新子」
  const S2 = oxCreate();
  S2.board[3] = 1; S2.hand[0] = 0; S2.turn = 0; S2.cursor = 3;
  const r = cf(S2, 0);                               // 指向自己的棋子 → 還是可以拿起
  ok('手牌用完仍可拿起場上的棋子', r.ok && r.ev[0].t === 'pick', JSON.stringify(r));
  const S3 = oxCreate();
  S3.board[3] = 1; S3.hand[0] = 0; S3.turn = 0; S3.cursor = 5;
  const r3 = cf(S3, 0);                              // 指向空格想下新子
  ok('手牌用完不能下新子（empty-hand）', !r3.ok && r3.why === 'empty-hand', JSON.stringify(r3));
  ok('被拒絕時狀態完全不變', S3.board[5] === 0 && S3.turn === 0 && S3.moves === 0);
}

/* ---------------- 4. 三連線 ---------------- */
console.log('\n【4】勝負判定');
{
  // 橫線：0,1,2
  const S = oxCreate();
  S.board[0] = 1; S.board[1] = 1; S.board[3] = 2; S.board[4] = 2;
  S.turn = 0; S.cursor = 2; S.hand[0] = 3;
  const r = cf(S, 0);
  ok('橫線三連 → win、winner=0', S.over && S.winner === 0, JSON.stringify(r));
  ok('winLine 是 [0,1,2]', JSON.stringify(S.winLine) === '[0,1,2]', JSON.stringify(S.winLine));
  ok('有 win 事件', r.ev.some(e => e.t === 'win' && e.p === 0), JSON.stringify(r.ev));
  ok('結束後指令一律被拒', cf(S, 1).ok === false && mv(S, 1, 'up').ok === false);

  // 直線：0,3,6
  const V = oxCreate();
  V.board[0] = 2; V.board[3] = 2; V.board[1] = 1; V.turn = 1; V.cursor = 6; V.hand[1] = 3;
  cf(V, 1);
  ok('直線三連 → winner=1、winLine [0,3,6]',
     V.over && V.winner === 1 && JSON.stringify(V.winLine) === '[0,3,6]', JSON.stringify(V.winLine));

  // 斜線：2,4,6
  const D = oxCreate();
  D.board[2] = 1; D.board[4] = 1; D.board[0] = 2; D.turn = 0; D.cursor = 6; D.hand[0] = 2;
  cf(D, 0);
  ok('斜線三連 → winLine [2,4,6]', D.over && JSON.stringify(D.winLine) === '[2,4,6]', JSON.stringify(D.winLine));

  ok('oxLine 對空盤回 null', oxLine(oxCreate()) === null);
}

/* ---------------- 5. 40 步上限 → 和局 ---------------- */
console.log('\n【5】40 步上限');
{
  const S = oxCreate();
  S.moves = OXG.MAX_MOVES - 1; S.turn = 0; S.cursor = 0; S.hand[0] = 4;
  const r = cf(S, 0);
  ok('第 40 步 → 和局（over、winner=-1、draw）',
     S.over && S.winner === -1 && S.draw === true, JSON.stringify({ over: S.over, w: S.winner, d: S.draw }));
  ok('有 draw 事件', r.ev.some(e => e.t === 'draw'));
  ok('和局不算任何人的勝場（winner -1）', S.winner === -1);
  ok('第 39 步還不會結束', (() => {
    const T = oxCreate(); T.moves = OXG.MAX_MOVES - 2; T.turn = 0; T.cursor = 0;
    cf(T, 0); return T.over === false && T.moves === OXG.MAX_MOVES - 1;
  })());
}

/* ---------------- 6. 回合鎖 ---------------- */
console.log('\n【6】回合鎖（最重要的一項）');
{
  const S = oxCreate();
  const before = snap(S);
  const r1 = cf(S, 1);                                   // 不是他的回合
  ok('非當前玩家按確認 → ok:false、why not-turn', !r1.ok && r1.why === 'not-turn', JSON.stringify(r1));
  ok('狀態完全沒變', snap(S) === before);
  const r2 = mv(S, 1, 'down');
  ok('非當前玩家也不能動游標', !r2.ok && snap(S) === before, JSON.stringify(r2));
  for (let i = 0; i < 10; i++) cf(S, 1);                 // 連送 10 次
  ok('連送 10 次非法指令 → 棋盤仍是空的', S.board.every(v => v === 0) && S.turn === 0 && S.moves === 0);

  cf(S, 0);                                              // 合法的這一步
  ok('合法指令生效、換手', S.board[4] === 1 && S.turn === 1 && S.moves === 1);
  for (let i = 0; i < 10; i++) cf(S, 0);                 // 換手後原本那位再連送
  ok('換手後原玩家連送 10 次 → 棋盤只有一顆、turn 沒被推走',
     S.board.filter(v => v !== 0).length === 1 && S.turn === 1 && S.moves === 1,
     JSON.stringify({ b: S.board, t: S.turn, mv: S.moves }));
}

/* ---------------- 7. 決定性 ---------------- */
console.log('\n【7】決定性');
{
  const run = () => {
    const S = oxCreate();
    const seq = [
      [0, 'confirm'], [1, 'confirm'], [0, 'right'], [0, 'confirm'],
      [1, 'left'], [1, 'confirm'], [0, 'down'], [0, 'confirm'],
      [1, 'up'], [1, 'confirm'], [0, 'up'], [0, 'confirm'],
    ];
    const evs = [];
    for (const [p, a] of seq) {
      const r = (a === 'confirm') ? cf(S, p) : mv(S, p, a);
      evs.push(r.ok + ':' + (r.ev || []).map(e => e.t).join(','));
      if (!r.ok && r.why) evs[evs.length - 1] += ':' + r.why;
    }
    return { S: snap(S), ev: JSON.stringify(evs) };
  };
  const A1 = run(), A2 = run();
  ok('同指令序列跑兩次：狀態完全一致', A1.S === A2.S);
  ok('同指令序列跑兩次：事件序列完全一致', A1.ev === A2.ev);
  ok('有真的改變棋盤', JSON.parse(A1.S).board.some(v => v !== 0));
}

console.log('\n' + res.join('\n'));
console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
process.exit(fail ? 1 : 0);
