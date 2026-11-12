import fs from 'node:fs';
import path from 'node:path';
const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== SPLAT 邏輯 BEGIN');
const b = html.indexOf('/* ===== SPLAT 邏輯 END ===== */');
if (a < 0 || b < 0) throw new Error('找不到 SPLAT 邏輯區塊');
const S0 = new Function(html.slice(a, b) + '\nreturn { SPG, spCreate, spCmd, spStep };')();
const { SPG, spCreate, spCmd, spStep } = S0;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '   → ' + e : '')); } };
const count = (S, v) => S.grid.reduce((n, x) => n + (x === v ? 1 : 0), 0);

console.log('\n【1】移動與邊界');
{
  const S = spCreate();
  const r = spCmd(S, 0, 'right');
  ok('P1 起步 (0,0) 往右 → (1,0)', r.ok && S.P[0].x === 1 && S.P[0].y === 0, JSON.stringify(S.P[0]));
  const L = spCmd(S, 0, 'left'); const U = spCmd(S, 0, 'up');
  ok('從 (1,0) 往左 → (0,0) 成功', S.P[0].x === 0, JSON.stringify(S.P[0]));
  ok('已經在最上面 → 往上被擋（edge）', !spCmd(spCreate(), 0, 'up').ok);
  const E = spCreate();
  let last = null;
  for (let i = 0; i < 40; i++) last = spCmd(E, 1, 'right');           // P2 從最右邊開始
  ok('P2 在最右欄 → 往右一律 edge', !last.ok && E.P[1].x === SPG.COLS - 1, JSON.stringify(E.P[1]));
  ok('非法方向 → bad-dir', !spCmd(spCreate(), 0, 'x').ok);
}

console.log('\n【2】塗色');
{
  const S = spCreate();
  spCmd(S, 0, 'right'); spCmd(S, 0, 'down');
  ok('走過的格子變 1（起點不塗，只塗落點共 2 格）', count(S, 1) === 2 && S.grid[0] === 0 && S.grid[1] === 1 && S.grid[SPG.COLS + 1] === 1, 'count=' + count(S, 1));
  ok('P2 的格子還是 0（只有自己塗）', count(S, 2) === 0);
  spCmd(S, 1, 'left');
  ok('P2 走一格 → 2 的格子 1 個', count(S, 2) === 1, 'count=' + count(S, 2));
}

console.log('\n【3】big 2×2 與覆蓋');
{
  const S = spCreate();
  S.P[0].x = 6; S.P[0].y = 4; S.P[0].big = 4;          // 在道具旁邊
  spCmd(S, 0, 'right');                                  // → (7,4) = 道具格
  ok('吃到 💥 → big=4', Math.abs(S.P[0].big - 4) < 0.01 && S.prop.on === 0, 'big=' + S.P[0].big);
  const before = count(S, 1);
  spCmd(S, 0, 'down');                                   // (7,5) 塗 2×2 = 4 格
  ok('big 狀態一次塗 2×2（新格 2 個，另 2 格上一動已塗過）', count(S, 1) - before === 2 && S.grid[5*15+8] === 1 && S.grid[6*15+7] === 1, `Δ=${count(S, 1) - before}`);
  // 覆蓋對手
  const T = spCreate();
  T.grid[1] = 2; T.P[0].x = 0; T.P[0].y = 0;
  spCmd(T, 0, 'right');
  ok('走到對手的格子 → 蓋成自己的（1）', T.grid[1] === 1);
}

console.log('\n【4】結束條件');
{
  const S = spCreate();
  S.grid[0] = 1; S.grid[1] = 1; S.grid[2] = 2;
  S.time = 0.01;
  const ev = spStep(S, 1 / 20);
  ok('30 秒到 → over、比分高者勝（winner=0）', S.over && S.winner === 0, JSON.stringify({ o: S.over, w: S.winner }));
  ok('有 win 事件', ev.some(e => e.t === 'win'));
  const T = spCreate();
  T.grid[5] = 1; T.grid[6] = 2; T.time = 0.01;
  spStep(T, 1 / 20);
  ok('同格數 → winner=-1（平手）', T.over && T.winner === -1);
  ok('結束後指令無效', !spCmd(T, 0, 'right').ok);
  ok('結束後 step 不會再改分數', (() => { const w = T.winner; spStep(T, 1); return T.winner === w; })());
}

console.log('\n【5】決定性');
{
  const run = () => {
    const S = spCreate(); const dirs = ['right', 'down', 'right', 'up', 'right', 'down'];
    for (let i = 0; i < 40; i++) { spCmd(S, 0, dirs[i % 6]); spCmd(S, 1, dirs[(i + 3) % 6]); spStep(S, 1 / 20); }
    return JSON.stringify({ g: Array.from(S.grid), p: S.P });
  };
  ok('同指令序列兩次完全一致', run() === run());
}

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
process.exit(fail ? 1 : 0);
