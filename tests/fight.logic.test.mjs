import fs from 'node:fs';
import path from 'node:path';
const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== FIGHT 邏輯 BEGIN');
const b = html.indexOf('/* ===== FIGHT 邏輯 END ===== */');
if (a < 0 || b < 0) throw new Error('找不到 FIGHT 邏輯區塊');
const F = new Function(html.slice(a, b) + '\nreturn { FGG, fgCreate, fgCmd, fgStep };')();
const { FGG, fgCreate, fgCmd, fgStep } = F;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '   → ' + e : '')); } };
const cmd = (o = {}) => [{ l: 0, r: 0, b: 0, ...o[0] }, { l: 0, r: 0, b: 0, ...o[1] }];

/** 讓 i 攻擊並跑到判定點為止（0.42 進度 ≈ 0.19 秒；7 步 = 0.233s，命中後仍在 hurt） */
function swing(S, i, cmds, steps = 7) {
  const evs = [];
  evs.push(...fgCmd(S, i, cmds[i]));
  for (let k = 0; k < steps; k++) evs.push(...fgStep(S, 1 / 30, cmds));
  return evs;
}

console.log('\n【1】攻擊距離');
{
  const S = fgCreate();
  S.x = [-1.0, 1.0];                       // 距離 2.0 < ATK_RANGE 2.6
  const evs = swing(S, 0, cmd());
  const hit = evs.find((e) => e.t === 'hit');
  ok('距離 2.0 命中、扣 14', !!hit && hit.dmg === 14 && S.hp[1] === FGG.MAXHP - 14,
     `hit=${JSON.stringify(hit)} hp=${S.hp[1]}`);
  ok('被打的一方進 hurt', S.st[1] === 'hurt', S.st[1]);
}
{
  const S = fgCreate();
  S.x = [-3.0, 1.0];                       // 距離 4.0 > 2.6
  const evs = swing(S, 0, cmd());
  ok('距離 4.0 不命中（HP 不變）', !evs.some((e) => e.t === 'hit') && S.hp[1] === 100, 'hp=' + S.hp[1]);
}
{
  const S = fgCreate();
  S.x = [-1.0, 1.0];
  S.face[0] = -1;                          // 背對對手
  const evs = swing(S, 0, cmd());
  ok('背對不命中', !evs.some((e) => e.t === 'hit'), 'hp=' + S.hp[1]);
}

console.log('\n【2】冷卻與防禦');
{
  const S = fgCreate();
  S.x = [-1.0, 1.0];
  fgCmd(S, 0, cmd()[0]);
  const r2 = fgCmd(S, 0, cmd()[0]);
  ok('攻擊中不能再出拳（狀態是 attack）', S.st[0] === 'attack' && r2.length === 0, S.st[0]);
  // 跑完整個攻擊 + 冷卻
  for (let k = 0; k < 30; k++) fgStep(S, 1 / 30, cmd());
  ok('冷卻結束後可以再攻擊', S.cool[0] === 0 && S.st[0] === 'idle', `cool=${S.cool[0]} st=${S.st[0]}`);
}
{
  const S = fgCreate();
  S.x = [-1.0, 1.0];
  const evs = swing(S, 0, cmd({ 1: { b: 1 } }));   // 對手按住防禦
  const hit = evs.find((e) => e.t === 'hit');
  ok('防禦時只扣 4（14×0.25）', !!hit && hit.dmg === 4 && S.hp[1] === 96, `hit=${JSON.stringify(hit)} hp=${S.hp[1]}`);
  ok('防禦時擊退較小（0.35 而非 1.25）', hit && hit.guard === 1, JSON.stringify(hit));
}

console.log('\n【3】受傷恢復');
{
  const S = fgCreate();
  S.x = [-1.0, 1.0];
  swing(S, 0, cmd());
  const wasHurt = S.st[1] === 'hurt';
  for (let k = 0; k < 12; k++) fgStep(S, 1 / 30, cmd());   // 再 0.4 秒（總計 > HURT_T 0.26）
  ok('hurt 約 0.26 秒後回 idle', wasHurt && S.st[1] === 'idle', `wasHurt=${wasHurt} st=${S.st[1]}`);
}

console.log('\n【4】擊倒');
{
  const S = fgCreate();
  S.x = [-1.0, 1.0];
  S.hp[1] = 10;
  const evs = swing(S, 0, cmd());
  ok('HP 歸零 → over、winner=0、st=dead',
     S.over && S.winner === 0 && S.st[1] === 'dead' && S.hp[1] === 0,
     JSON.stringify({ hp: S.hp, st: S.st, over: S.over, win: S.winner }));
  ok('有 win 事件', evs.some((e) => e.t === 'win' && e.p === 0));
  const before = JSON.stringify(S);
  const ev2 = swing(S, 0, cmd());
  ok('結束後指令無效（狀態不變）', ev2.length === 0 && JSON.stringify(S) === before);
}

console.log('\n【5】移動與不能穿過');
{
  const S = fgCreate();
  S.x = [-1.0, 8.5];                        // 對手在很遠，不會碰撞
  for (let k = 0; k < 30; k++) fgStep(S, 1 / 30, cmd({ 0: { r: 1 } }));   // P1 往右 1 秒
  ok('按住右 1 秒 → 位移約 7.6（±1）', Math.abs(S.x[0] - (-1.0 + FGG.SPEED)) < 1.2, 'x0=' + S.x[0].toFixed(2));
  ok('面向變成 +1', S.face[0] === 1, S.face[0]);
}
{
  const S = fgCreate();
  S.x = [-0.3, 0.3];                        // 已經比 MIN_SEP 小
  fgStep(S, 1 / 30, cmd());
  ok('距離被推到 MIN_SEP 以上', Math.abs(S.x[1] - S.x[0]) >= FGG.MIN_SEP - 0.001,
     'sep=' + Math.abs(S.x[1] - S.x[0]).toFixed(3));
}
{
  const S = fgCreate();
  S.x = [-1.2, 1.2];
  for (let k = 0; k < 120; k++) { fgStep(S, 1 / 30, cmd({ 0: { r: 1 }, 1: { l: 1 } })); }
  ok('兩人對撞不會穿過（維持 1.15 附近）', Math.abs(S.x[1] - S.x[0]) >= FGG.MIN_SEP - 0.001,
     'sep=' + Math.abs(S.x[1] - S.x[0]).toFixed(3));
  ok('不會跑出場地（|x| ≤ 9）', Math.abs(S.x[0]) <= 9 && Math.abs(S.x[1]) <= 9, JSON.stringify(S.x));
}

console.log('\n【6】防禦減速');
{
  const A = fgCreate(); A.x = [-1.0, 1.0];
  const B = fgCreate(); B.x = [-1.0, 1.0];
  for (let k = 0; k < 30; k++) { fgStep(A, 1 / 30, cmd({ 0: { r: 1 } })); fgStep(B, 1 / 30, cmd({ 0: { r: 1, b: 1 } })); }
  const da = A.x[0] - (-1.0), db = B.x[0] - (-1.0);
  ok(`防禦時移動變慢（${da.toFixed(2)} vs ${db.toFixed(2)}，約 0.35 倍）`, db < da * 0.5 && db > 0, `slow=${db.toFixed(2)}`);
}

console.log('\n【7】決定性');
{
  const run = () => {
    const S = fgCreate();
    const script = [[0, { r: 1 }], [0, {}], [1, { l: 1 }], [0, {}]];
    const evs = [];
    for (let k = 0; k < 60; k++) {
      const c = cmd();
      const step = script[k % script.length];
      if (step[1].r) c[step[0]].r = 1; if (step[1].l) c[step[0]].l = 1;
      if (k % 17 === 0) fgCmd(S, k % 2, c[k % 2]);
      evs.push(...fgStep(S, 1 / 30, c));
    }
    return JSON.stringify({ S, evs });
  };
  ok('同輸入序列跑兩次完全一致', run() === run());
}

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
process.exit(fail ? 1 : 0);
