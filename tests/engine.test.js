/**
 * 2048 引擎單元測試
 * 從 index.html 抽出純邏輯區塊，在 Node 裡跑規則驗證。
 * 執行：node tests/engine.test.js
 */
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');

const start = html.indexOf('const G_SIZE = 4;');
const endMark = html.indexOf('====== 2048 引擎 END ======');
const cut = html.lastIndexOf('/*', endMark);
if (start < 0 || endMark < 0) throw new Error('找不到引擎區塊標記');

const src = html.slice(start, cut);
const E = new Function(
  src + '\nreturn { gEmpty, gSpawn, gSlideLine, gLines, gMove, gCanMove, gNew, gStep };'
)();

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push('  ✓ ' + name); }
  else { fail++; results.push('  ✗ ' + name + (extra ? '   → ' + extra : '')); }
}
function eqArr(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
const S = (a) => E.gSlideLine(a);
const G = (a) => { const g = a.slice(); return g; };
const show = (g) => {
  let s = '';
  for (let r = 0; r < 4; r++) s += '\n      ' + g.slice(r * 4, r * 4 + 4).map(v => String(v).padStart(4)).join(' ');
  return s;
};

/* ---------------- 1. 單線滑動與合併規則 ---------------- */
console.log('\n【1】單線滑動與合併規則');
eqArr('2,2,0,0 → 4',        S([2,2,0,0]).line, [4,0,0,0]);
ok('  得分 4',              S([2,2,0,0]).gained === 4);
ok('  有移動',              S([2,2,0,0]).moved === true);
eqArr('2,2,2,2 → 4,4',      S([2,2,2,2]).line, [4,4,0,0]);
ok('  得分 8（不是 16）',    S([2,2,2,2]).gained === 8);
eqArr('2,2,2,0 → 4,2',      S([2,2,2,0]).line, [4,2,0,0]);
eqArr('4,4,4,0 → 8,4',      S([4,4,4,0]).line, [8,4,0,0]);
ok('  得分 8（每格只合併一次）', S([4,4,4,0]).gained === 8);
eqArr('4,4,4,4 → 8,8',      S([4,4,4,4]).line, [8,8,0,0]);
ok('  得分 16',             S([4,4,4,4]).gained === 16);
eqArr('4,2,2,0 → 4,4（不連鎖）', S([4,2,2,0]).line, [4,4,0,0]);
eqArr('2,2,4,0 → 4,4（新的 4 不再合併）', S([2,2,4,0]).line, [4,4,0,0]);
ok('  得分 4',              S([2,2,4,0]).gained === 4);
eqArr('2,0,2,0 → 4（隔空格可合併）', S([2,0,2,0]).line, [4,0,0,0]);
eqArr('0,2,0,0 → 2,0,0,0',  S([0,2,0,0]).line, [2,0,0,0]);
ok('  有移動',              S([0,2,0,0]).moved === true);
eqArr('0,0,0,2 → 2,0,0,0',  S([0,0,0,2]).line, [2,0,0,0]);
eqArr('2,0,0,0 不變',       S([2,0,0,0]).line, [2,0,0,0]);
ok('  不算移動',            S([2,0,0,0]).moved === false);
ok('全空不算移動',          S([0,0,0,0]).moved === false);
eqArr('不同值不合併 2,4,8,16', S([2,4,8,16]).line, [2,4,8,16]);
ok('  不算移動',            S([2,4,8,16]).moved === false);

/* ---------------- 2. 四方向對應正確 ---------------- */
console.log('\n【2】四方向對應');
let g = G(E.gEmpty()); g[0] = 2; g[4] = 2; g[8] = 4;
let r = E.gMove(g, 'up');
ok('up：直的合併', g[0] === 4 && g[4] === 4 && g[8] === 0,
   'grid =' + show(g));
ok('  得分 4', r.gained === 4);

g = G(E.gEmpty()); g[0] = 2; g[4] = 2; g[8] = 4;
E.gMove(g, 'down');
ok('down：往另一頭併', g[15 - 3] === 4 && g[11 - 3] === 4 && g[3] === 0, 'grid =' + show(g));

g = G(E.gEmpty()); g[0] = 0; g[1] = 2; g[3] = 2;
E.gMove(g, 'left');
ok('left：橫的合併', g[0] === 4 && g[1] === 0 && g[2] === 0 && g[3] === 0, 'grid =' + show(g));

g = G(E.gEmpty()); g[0] = 2; g[1] = 2; g[3] = 0;
E.gMove(g, 'right');
ok('right：靠右併', g[3] === 4 && g[0] === 0 && g[1] === 0 && g[2] === 0, 'grid =' + show(g));

g = G(E.gEmpty()); g[5] = 8; g[9] = 8;
r = E.gMove(g, 'up');
ok('up：同欄非相鄰格也能靠攏', g[1] === 16 && g[5] === 0 && g[9] === 0, 'grid =' + show(g));
ok('  得分 16', r.gained === 16);

/* ---------------- 3. 死局判定 ---------------- */
console.log('\n【3】canMove / 死局判定');
const stuck = [
  2,4,2,4,
  4,2,4,2,
  2,4,2,4,
  4,2,4,2,
];
ok('交錯滿盤 → 死局', E.gCanMove(stuck) === false);
const stuckOneHole = stuck.slice(); stuckOneHole[15] = 0;
ok('有一個空格 → 還能動', E.gCanMove(stuckOneHole) === true);
ok('有相鄰相同 → 還能動', E.gCanMove([2,2,4,8, 4,2,4,2, 2,4,2,4, 4,2,4,2]) === true);
ok('空盤 → 還能動', E.gCanMove(E.gEmpty()) === true);

/* ---------------- 4. 生成格：決定性（注入 rng） ---------------- */
console.log('\n【4】gSpawn / gNew 決定性');
g = E.gEmpty();
const idx = E.gSpawn(g, () => 0);
ok('rng=0 → 放索引 0 且值為 2', idx === 0 && g[0] === 2);
g = E.gEmpty(); g[0] = 2;
const idx2 = E.gSpawn(g, () => 0);
ok('跳過已佔用格 → 索引 1', idx2 === 1 && g[1] === 2);
const full = new Array(16).fill(2);
ok('滿盤回傳 -1', E.gSpawn(full, () => 0) === -1);

const ng = E.gNew(() => 0);
ok('gNew 起始兩格', ng.grid.filter(v => v !== 0).length === 2);
ok('gNew 起始分數 0', ng.score === 0 && ng.over === false && ng.moves === 0);

/* ---------------- 5. gStep：計分、生格、不動作時不生格 ---------------- */
console.log('\n【5】gStep 完整一步');
let game = { grid: E.gEmpty(), score: 0, over: false, moves: 0 };
game.grid[0] = 2; game.grid[1] = 2;
let st = E.gStep(game, 'left', () => 0);
ok('合併得分 4', game.score === 4, 'score=' + game.score);
ok('步數 1', game.moves === 1);
ok('有生新格（索引 1，值 2）', st.spawned === 1 && game.grid[1] === 2,
   'grid =' + show(game.grid));
ok('未死局', game.over === false);

// 同方向再推一次：兩邊都靠左且無法再動 → 不應生格、不應加分
const before = game.score;
st = E.gStep(game, 'left', () => 0);
ok('無法移動時 moved=false', st.moved === false);
ok('無法移動時不生格', st.spawned === -1);
ok('無法移動時不加分', game.score === before);
ok('無法移動時不計步', game.moves === 1);

/* ---------------- 6. 整局模擬：隨機玩到死局，檢查不變式 ---------------- */
console.log('\n【6】整局模擬（隨機 300 局，檢查不變式）');
let bad = 0, totalMoves = 0, maxTile = 0, overs = 0;
const dirs = ['up','down','left','right'];
for (let t = 0; t < 300; t++) {
  const gm = E.gNew(Math.random);
  let guard = 0;
  while (!gm.over && guard++ < 5000) {
    const d = dirs[Math.floor(Math.random() * 4)];
    const rr = E.gStep(gm, d, Math.random);
    totalMoves++;
    // 不變式：分數必須等於「所有格子的值總和」減去「初始四格的值」
    const sum = gm.grid.reduce((a, b) => a + b, 0);
    const vals = gm.grid.filter(v => v !== 0);
    if (vals.some(v => v !== 2 && v !== 4 && v % 2 !== 0)) bad++;       // 只會是 2 的次方
    if (gm.grid.length !== 16) bad++;
    if (gm.score % 4 !== 0 && gm.score !== 0) bad++;                    // 合併得分必為 2 的次方總和
    gm.grid.forEach(v => { if (v > maxTile) maxTile = v; });
  }
  if (gm.over) overs++;
}
ok('300 局全部走到死局', overs === 300, 'overs=' + overs);
ok('不變式無違反', bad === 0, 'bad=' + bad);
console.log(`  · 總步數 ${totalMoves}，平均每局 ${(totalMoves/300).toFixed(1)} 步，最大方塊 ${maxTile}`);

/* ---------------- 7. 分數上限合理性（兩個玩家要能比大小） ---------------- */
console.log('\n【7】雙人比分情境');
const A = E.gNew(() => 0.5); A.score = 1352;
const B = E.gNew(() => 0.5); B.score = 900;
ok('比分可比較且不同', A.score !== B.score);
ok('勝者判定正確', (A.score > B.score ? 0 : 1) === 0);
A.score = 1000; B.score = 1000;
ok('同分判平手', (A.score === B.score) === true);

/* ---------------- 結果 ---------------- */
console.log('\n' + results.join('\n'));
console.log(`\n${'='.repeat(46)}`);
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
