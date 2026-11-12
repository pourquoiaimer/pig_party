import fs from 'node:fs';
import path from 'node:path';
const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== MATH 邏輯 BEGIN');
const b = html.indexOf('/* ===== MATH 邏輯 END ===== */');
if (a < 0 || b < 0) throw new Error('找不到 MATH 邏輯區塊');
const M = new Function(html.slice(a, b) + '\nreturn { MTG, mtCreate, mtStart, mtAnswer, mtStep, mtNewRound };')();
const { MTG, mtCreate, mtStart, mtAnswer, mtStep, mtNewRound } = M;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '   → ' + e : '')); } };
const mkRnd = (seed) => { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; };
const rightIdx = (S, p) => S.opts[p].indexOf(S.q[p].ans);
const wrongIdx = (S, p) => S.opts[p].findIndex((v, i) => v !== S.q[p].ans && S.wrong[p].indexOf(i) < 0);

console.log('\n【1】開賽（兩人各自有題目）');
{
  const S = mtStart(mtCreate('easy'), mkRnd(9));
  ok('兩人都有題目', !!S.q[0] && !!S.q[1]);
  ok('兩人各有 4 個選項且答案在其中',
     S.opts[0].length === 4 && S.opts[1].length === 4 && rightIdx(S, 0) >= 0 && rightIdx(S, 1) >= 0);
  ok('兩人骰子 1~6', S.dice[0] >= 1 && S.dice[0] <= 6 && S.dice[1] >= 1 && S.dice[1] <= 6, JSON.stringify(S.dice));
  ok('初始位置 0/0、倒數 10 秒', S.pos[0] === 0 && S.pos[1] === 0 && S.round[0] === MTG.ROUND && S.round[1] === MTG.ROUND);
  ok('題目算式正確', [0, 1].every((p) => {
    const q = S.q[p];
    return q.op === '+' ? q.a + q.b === q.ans : q.op === '-' ? q.a - q.b === q.ans : q.a * q.b === q.ans;
  }));
  ok('兩人題目互不干擾（物件不同）', S.q[0] !== S.q[1] && S.opts[0] !== S.opts[1]);
}

console.log('\n【2】答對：前進＋自己換題');
{
  const S = mtStart(mtCreate('easy'), mkRnd(21));
  const dice = S.dice[0], q0 = S.q[0];
  const r = mtAnswer(S, 0, rightIdx(S, 0), mkRnd(31));
  ok('前進骰子點數', r.ok && S.pos[0] === dice, `pos=${S.pos[0]} dice=${dice}`);
  ok('自己換了新題目', S.q[0] !== q0 && !!S.q[0]);
  ok('自己重擲骰子、倒數重置', S.dice[0] >= 1 && S.round[0] === MTG.ROUND);
  ok('對手完全沒變（位置/題目/骰子）', S.pos[1] === 0 && !!S.q[1] && S.dice[1] >= 1);
  ok('hits 計數 +1', S.hits[0] === 1);
}

console.log('\n【3】答錯：退 1 格＋罰站＋記住錯選項');
{
  const S = mtStart(mtCreate('easy'), mkRnd(5));
  S.pos[0] = 5;
  const wi = wrongIdx(S, 0);
  const r = mtAnswer(S, 0, wi, mkRnd(6));
  ok('後退 1 格', r.ok && S.pos[0] === 4, 'pos=' + S.pos[0]);
  ok('進入罰站 2 秒', S.freeze[0] === MTG.FREEZE, 'fz=' + S.freeze[0]);
  ok('記住按錯的選項', S.wrong[0].indexOf(wi) >= 0, JSON.stringify(S.wrong[0]));
  ok('同一個錯選項不能再按', !mtAnswer(S, 0, wi, mkRnd(6)).ok);
  ok('罰站期間不能作答（連正確答案也不行）', !mtAnswer(S, 0, rightIdx(S, 0), mkRnd(6)).ok);
  for (let i = 0; i < 25; i++) mtStep(S, 0.1);
  ok('2 秒後罰站結束', S.freeze[0] === 0);
  ok('罰站結束後可以再答', mtAnswer(S, 0, rightIdx(S, 0), mkRnd(7)).ok);
}

console.log('\n【4】題目超時換題');
{
  const S = mtStart(mtCreate('easy'), mkRnd(77));
  const q0 = S.q[0];
  let ev = [];
  for (let i = 0; i < 105; i++) ev = ev.concat(mtStep(S, 0.1));
  ok('10 秒沒答 → timeout 事件', ev.some((e) => e.t === 'timeout' && e.p === 0), JSON.stringify(ev).slice(0, 80));
  mtNewRound(S, 0, mkRnd(78));
  ok('換題後是新題目', S.q[0] !== q0 && !!S.q[0]);
  ok('倒數重置回 10 秒', S.round[0] === MTG.ROUND);
  ok('對手這 10 秒不受影響', S.pos[1] === 0);
}

console.log('\n【5】獲勝');
{
  const S = mtStart(mtCreate('easy'), mkRnd(11));
  S.pos[0] = MTG.N - 3;
  S.dice[0] = 6;
  const r = mtAnswer(S, 0, rightIdx(S, 0), mkRnd(12));
  ok('超過終點夾在最後一格並獲勝', r.ok && S.over && S.winner === 0 && S.pos[0] === MTG.N - 1,
     JSON.stringify({ over: S.over, win: S.winner, pos: S.pos[0] }));
  ok('結束後作答無效', !mtAnswer(S, 0, 0, mkRnd(12)).ok);
}

console.log('\n【6】難度');
{
  for (const mode of ['easy', 'medium', 'hard']) {
    let good = true;
    const rnd = mkRnd(3);
    for (let i = 0; i < 20; i++) {
      const S = mtStart(mtCreate(mode), rnd);
      for (const p of [0, 1]) {
        if (!S.q[p] || S.opts[p].length !== 4 || rightIdx(S, p) < 0) good = false;
        if (mode === 'hard' && S.q[p].op !== '*') good = false;
        if (mode === 'easy' && (S.q[p].a > 10 || S.q[p].b > 10)) good = false;
      }
    }
    ok(`${mode}：20 局 × 2 人都合法`, good);
  }
}

console.log('\n【7】決定性');
{
  const run = () => {
    const S = mtStart(mtCreate('easy'), mkRnd(123));
    const rnd = mkRnd(456);
    const evs = [];
    for (let i = 0; i < 30; i++) {
      const p = i % 2;
      const k = i % 3 === 0 ? rightIdx(S, p) : wrongIdx(S, p);
      evs.push(...mtAnswer(S, p, k, rnd).ev);
      for (let t = 0; t < 5; t++) evs.push(...mtStep(S, 0.1));
      if (S.over) break;
    }
    return JSON.stringify({ S, evs });
  };
  ok('同 seed 跑兩次完全一致', run() === run());
}

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
process.exit(fail ? 1 : 0);
