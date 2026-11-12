import fs from 'node:fs';
import path from 'node:path';
const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== RACE 邏輯 BEGIN');
const b = html.indexOf('/* ===== RACE 邏輯 END ===== */');
if (a < 0 || b < 0) throw new Error('找不到 RACE 邏輯區塊');
const R = new Function(html.slice(a, b) + '\nreturn { RCG, rcCreate, rcCmd, rcStep };')();
const { RCG, rcCreate, rcCmd, rcStep } = R;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '   → ' + e : '')); } };

console.log('\n【1】跳躍');
{
  const S = rcCreate();
  const r = rcCmd(S, 0, 'up');
  ok('地面上按上 → 離地、vy=−820', r.ok && S.P[0].onGround === false && S.P[0].vy === -820, JSON.stringify(S.P[0]));
  const r2 = rcCmd(S, 0, 'up');
  ok('空中不能再跳（air）', !r2.ok && r2.why === 'air', JSON.stringify(r2));
  ok('只有自己的跑者受影響', S.P[1].onGround === true && S.P[1].vy === 0);
}

console.log('\n【2】重力');
{
  const S = rcCreate();
  rcCmd(S, 0, 'up');
  let ticks = 0;
  while (!S.P[0].onGround && ticks < 600) { rcStep(S, 1 / 60); ticks++; }
  const tSec = ticks / 60;
  ok(`落地約 2*820/2600≈0.63 秒（實測 ${tSec.toFixed(2)}s / ${ticks} tick）`, tSec > 0.55 && tSec < 0.72, tSec.toFixed(3));
  ok('落地後 onGround、vy=0、y 回到地面', S.P[0].onGround && S.P[0].vy === 0 && S.P[0].y === RCG.GROUND[0]);
}

console.log('\n【3】柵欄');
{
  const S = rcCreate();                       // 起點 60，第一根柵欄 250
  for (let i = 0; i < 8; i++) rcCmd(S, 0, 'right');   // 60 → 236
  ok('走到 236（還沒到柵欄）', S.P[0].x === 236, 'x=' + S.P[0].x);
  rcCmd(S, 0, 'right');                       // 258 → |258−250|<22 且在地面 → 彈回
  const ev = rcStep(S, 1 / 60);
  ok('沒跳 → 撞柵欄彈回 60px（x=198）', S.P[0].x === 198, 'x=' + S.P[0].x);
  ok('事件帶 hit', ev.some(e => e.t === 'hit' && e.p === 0), JSON.stringify(ev));

  const T = rcCreate();
  for (let i = 0; i < 8; i++) rcCmd(T, 0, 'right');
  rcCmd(T, 0, 'up');
  for (let i = 0; i < 6; i++) rcStep(T, 1 / 60);      // 0.1 秒 → 已離地約 100px
  rcCmd(T, 0, 'right');
  const ev2 = rcStep(T, 1 / 60);
  ok('跳過柵欄（高度 60 以上）→ 不觸發', !ev2.some(e => e.t === 'hit'), `y=${T.P[0].y.toFixed(0)} x=${T.P[0].x}`);
}

console.log('\n【4】終點');
{
  const S = rcCreate();
  S.P[0].x = RCG.FIN - 10;
  rcCmd(S, 0, 'right');
  const ev = rcStep(S, 1 / 60);
  ok('先到終點 → over、winner=0', S.over && S.winner === 0, JSON.stringify({ o: S.over, w: S.winner }));
  ok('win 事件', ev.some(e => e.t === 'win' && e.p === 0));
  ok('結束後指令一律無效', !rcCmd(S, 0, 'right').ok);
  const T = rcCreate();
  T.P[1].x = RCG.FIN;
  rcStep(T, 1 / 60);
  ok('P2 到終點 → winner=1', T.over && T.winner === 1);
}

console.log('\n【5】決定性');
{
  const run = () => {
    const S = rcCreate();
    for (let i = 0; i < 40; i++) {
      if (i % 7 === 3) rcCmd(S, 0, 'up'); else rcCmd(S, 0, 'right');
      rcStep(S, 1 / 60);
      if (i % 11 === 5) rcCmd(S, 1, 'right');
      rcStep(S, 1 / 60);
    }
    return JSON.stringify(S);
  };
  ok('同輸入序列跑兩次完全一致', run() === run());
}

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
process.exit(fail ? 1 : 0);
