import fs from 'node:fs';
import path from 'node:path';
const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== FRUIT 邏輯 BEGIN');
const b = html.indexOf('/* ===== FRUIT 邏輯 END ===== */');
if (a < 0 || b < 0) throw new Error('找不到 FRUIT 邏輯區塊');
const F = new Function(html.slice(a, b) + '\nreturn { FRG, frCreate, frStep };')();
const { FRG, frCreate, frStep } = F;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '   → ' + e : '')); } };
const rand = (seed) => { let s = seed || 1; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };
const idle = [{ l: 0, r: 0 }, { l: 0, r: 0 }];

console.log('\n【1】接取判定（籃子寬度）');
{
  const S = frCreate();
  S.items.length = 0; S.spawnT = 99; S.propT = 99;
  S.items.push({ x: S.P[0].x + 20, y: FRG.GY - 5, vy: 300, kind: 0, emo: 0 });
  const ev = frStep(S, 1 / 60, idle, rand(1));
  ok('籃子中心 ±44 內 → 接到（sc=1）', S.P[0].sc === 1 && ev.some(e => e.t === 'eat' && e.p === 0), JSON.stringify(S.P[0]));
  ok('接到的水果從清單移除', S.items.length === 0);

  const T = frCreate();
  T.items.length = 0; T.spawnT = 99; T.propT = 99;
  T.items.push({ x: T.P[0].x + 60, y: FRG.GY - 5, vy: 300, kind: 0, emo: 0 });
  frStep(T, 1 / 60, idle, rand(1));
  ok('超出籃子寬度（+60 > 44）→ 接不到', T.P[0].sc === 0 && T.items.length === 1);

  const W2 = frCreate();
  W2.items.length = 0; W2.spawnT = 99; W2.propT = 99; W2.P[0].wide = 3;
  W2.items.push({ x: W2.P[0].x + 60, y: FRG.GY - 5, vy: 300, kind: 0, emo: 0 });
  frStep(W2, 1 / 60, idle, rand(1));
  ok('大籃（寬 ×1.6 = 140.8/2）→ 同樣位置接得到', W2.P[0].sc === 1);
}

console.log('\n【2】boost / wide 時效');
{
  const S = frCreate();
  S.items.length = 0; S.spawnT = 99; S.propT = 99;
  S.items.push({ x: S.P[0].x, y: FRG.GY - 5, vy: 300, kind: 1, emo: 0 });
  frStep(S, 1 / 60, idle, rand(2));
  ok('吃到 boost → 4 秒', Math.abs(S.P[0].boost - 4) < 0.05, 'boost=' + S.P[0].boost.toFixed(2));
  ok('吃到 boost 的人有加速', S.P[0].boost > 0);
  const B2 = frCreate(); B2.items.length = 0; B2.spawnT = 99; B2.propT = 99; B2.P[1].boost = 4;
  const x0 = B2.P[1].x;
  for (let i = 0; i < 10; i++) frStep(B2, 1 / 60, [{ l: 0, r: 0 }, { l: 0, r: 1 }], rand(2));
  const dx1 = B2.P[1].x - x0;                       // 1/6 秒，未撞邊界
  ok('boost 期間速度 1.8×（約 684*0.167 = 114）', dx1 > 100 && dx1 < 130, 'dx=' + dx1.toFixed(0));
  for (let i = 0; i < 400; i++) frStep(S, 1 / 60, idle, rand(2));
  ok('boost 會到期歸零', S.P[0].boost <= 0, 'boost=' + S.P[0].boost.toFixed(2));

  const T = frCreate();
  T.items.length = 0; T.spawnT = 99; T.propT = 99;
  T.items.push({ x: T.P[1].x, y: FRG.GY - 5, vy: 300, kind: 2, emo: 0 });
  frStep(T, 1 / 60, idle, rand(3));
  ok('吃到 wide → 5 秒', Math.abs(T.P[1].wide - 5) < 0.05, 'wide=' + T.P[1].wide.toFixed(2));
  for (let i = 0; i < 340; i++) frStep(T, 1 / 60, idle, rand(3));
  ok('wide 會到期歸零', T.P[1].wide <= 0);
}

console.log('\n【3】結束條件');
{
  const S = frCreate();
  S.P[0].sc = 14;
  S.items.length = 0; S.spawnT = 99; S.propT = 99;
  S.items.push({ x: S.P[0].x, y: FRG.GY - 5, vy: 300, kind: 0, emo: 0 });
  const ev = frStep(S, 1 / 60, idle, rand(4));
  ok('先到 15 分 → 立刻結束、winner=0', S.over && S.winner === 0 && S.P[0].sc === 15, JSON.stringify({ o: S.over, w: S.winner, sc: S.P[0].sc }));
  ok('有 win 事件', ev.some(e => e.t === 'win'));

  const T = frCreate();
  T.time = 0.01; T.P[0].sc = 3; T.P[1].sc = 7;
  T.spawnT = 99; T.propT = 99;
  frStep(T, 1 / 60, idle, rand(5));
  ok('45 秒到 → 分數高者勝（winner=1）', T.over && T.winner === 1 && T.time === 0, JSON.stringify({ w: T.winner }));

  const U = frCreate();
  U.time = 0.01; U.P[0].sc = 5; U.P[1].sc = 5;
  U.spawnT = 99; U.propT = 99;
  frStep(U, 1 / 60, idle, rand(6));
  ok('時間到同分 → winner=-1（平手）', U.over && U.winner === -1);
  ok('結束後再 step 不會變動', (() => { const t0 = U.time; frStep(U, 1, idle, rand(6)); return U.time === t0; })());
}

console.log('\n【4】決定性（同 seed 同水果序列）');
{
  const run = (seed) => {
    const S = frCreate(); const r = rand(seed); const log = [];
    for (let i = 0; i < 600; i++) {
      frStep(S, 1 / 60, [{ l: 0, r: i % 30 < 15 ? 1 : 0 }, { l: i % 40 < 20 ? 1 : 0, r: 0 }], r);
      if (i % 10 === 0) log.push(S.items.map(it => `${Math.round(it.x)},${Math.round(it.y)},${it.kind}`).join('|'));
    }
    return JSON.stringify({ log, sc: S.P.map(p => p.sc), x: S.P.map(p => Math.round(p.x)), t: S.time.toFixed(2) });
  };
  ok('同 seed 兩次結果完全一致', run(77) === run(77));
  ok('不同 seed 水果序列不同', run(77) !== run(78));
}

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
process.exit(fail ? 1 : 0);
