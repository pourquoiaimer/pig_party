/**
 * 排球「純邏輯」測試（05A：抽成可兩邊跑的模組）
 *
 * 手法跟 tests/engine.test.js 一樣：讀 index.html、切出
 * 「===== VOLLEY 邏輯 BEGIN/END =====」那一段、在 Node 裡 new Function 執行。
 * 執行：node tests/volley.logic.test.mjs
 *
 * 這裡驗的是「規則與物理」——完全沒有 DOM／音效，所以伺服器（S 模式）之後會跑同一份。
 */
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('/* ===== VOLLEY 邏輯 BEGIN');
const endMark = html.indexOf('/* ===== VOLLEY 邏輯 END ===== */');
if (start < 0 || endMark < 0) throw new Error('找不到 VOLLEY 邏輯區塊標記');
const src = html.slice(start, endMark);

const V = new Function(
  src + '\nreturn { VOLLEY, vvCreate, vvStep, vvReset };'
)();
const { VOLLEY, vvCreate, vvStep, vvReset } = V;

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push('  ✓ ' + name); }
  else { fail++; results.push('  ✗ ' + name + (extra ? '   → ' + extra : '')); }
}
const DT = 1 / 60;
const IDLE = [{ l: false, r: false, u: false }, { l: false, r: false, u: false }];
const step = (S, inputs, n, dt = DT) => {
  let ev = [];
  for (let i = 0; i < n; i++) ev = ev.concat(vvStep(S, inputs || IDLE, dt));
  return ev;
};
/** 把球放到指定位置後讓它落地（x 決定誰得分） */
function forceLand(S, x) {
  S.ball.live = true; S.ball.cool = 0;
  S.ball.x = x; S.ball.y = VOLLEY.GY - VOLLEY.R - 1;
  S.ball.vx = 0; S.ball.vy = 120;
  return vvStep(S, IDLE, DT);
}

/* ---------------- 0. 區塊純度：不得引用 DOM／音效／隨機 ---------------- */
console.log('\n【0】邏輯區塊純度');
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, '')      // 區塊註解
  .replace(/^\s*\/\/.*$/gm, '');         // 行註解
for (const bad of ['document', 'window', 'blip', 'HELD', 'performance', 'Math.random', 'THREE', 'requestAnimationFrame'])
  ok(`不含 ${bad}`, !new RegExp('\\b' + bad.replace('.', '\\.') + '\\b').test(codeOnly));
ok('可以在 Node 單獨執行（vvCreate/vvStep/vvReset 都是 function）',
   [vvCreate, vvStep, vvReset].every(f => typeof f === 'function'));

/* ---------------- 1. 發球倒數 1 秒 ---------------- */
console.log('\n【1】發球倒數');
{
  const S = vvCreate();
  step(S, IDLE, 59);
  ok('0.98 秒時還沒發球（ball.live=false）', S.ball.live === false, 'live=' + S.ball.live);
  step(S, IDLE, 1);
  ok('滿 1.0 秒發球（ball.live=true）', S.ball.live === true, 'serveT=' + S.serveT);
  ok('發球初速 vy=60', Math.abs(S.ball.vy - 60) < 1e-9, 'vy=' + S.ball.vy);
  ok('初始 serveT=1.0（vvCreate）', vvCreate().serveT === 1.0);
  const S2 = vvCreate();
  vvReset(S2, 1);
  ok('vvReset 之後 serveT 回到 1.0、球在右半場',
     S2.serveT === 1.0 && Math.abs(S2.ball.x - VOLLEY.W * 0.64) < 1e-9,
     'x=' + S2.ball.x);
}

/* ---------------- 2. 落地判分 + 自動重置 ---------------- */
console.log('\n【2】落地判分與重置');
{
  const S = vvCreate();
  const ev = forceLand(S, 200);                    // 左半場落地
  const point = ev.find(e => e.t === 'point');
  ok('左半場落地 → 得分給右邊（p=1）', !!point && point.p === 1, JSON.stringify(ev));
  ok('比分 0 : 1', S.score[0] === 0 && S.score[1] === 1, JSON.stringify(S.score));
  ok('得分後自動重置：球回右半場、live=false、serveT=1.0',
     S.ball.live === false && S.serveT === 1.0 && Math.abs(S.ball.x - VOLLEY.W * 0.64) < 1e-9,
     `x=${S.ball.x} live=${S.ball.live} serveT=${S.serveT}`);
  ok('得分後發球交給得分方（server=1）', point && point.server === 1);
  ok('得分訊息文字（含比分）', S.msg === 'P2 藍 得分　0 : 1' && S.msgT === 1.4, JSON.stringify(S.msg));
  ok('得分特效 flashA=1、shake=12', S.flashA === 1 && S.shake === 12);

  const S2 = vvCreate();
  const ev2 = forceLand(S2, 700);                  // 右半場落地
  ok('右半場落地 → 得分給左邊（p=0）', ev2.find(e => e.t === 'point').p === 0);
  ok('比分 1 : 0', S2.score[0] === 1 && S2.score[1] === 0);
}

/* ---------------- 3. 7 分制結束 ---------------- */
console.log('\n【3】7 分制');
{
  const S = vvCreate();
  let winEv = null, lastPoint = null;
  for (let i = 0; i < 7; i++) {
    const ev = forceLand(S, 200);                  // 一直讓右邊得分
    lastPoint = ev.find(e => e.t === 'point');
    winEv = ev.find(e => e.t === 'win') || winEv;
    if (i < 6) ok(`第 ${i + 1} 分：比賽還沒結束`, S.over === false && S.score[1] === i + 1);
  }
  ok('第 7 分：over=true', S.over === true);
  ok('winner=1（右邊）', S.winner === 1, 'winner=' + S.winner);
  ok('結束訊息', S.msg === 'P2 藍 拿下這局！', JSON.stringify(S.msg));
  ok('結束那一分不再重置（server<0）', lastPoint && lastPoint.server === -1, JSON.stringify(lastPoint));
  ok('發出 win 事件', !!winEv && winEv.p === 1);
  ok('結束後 vvStep 不再改變狀態', vvStep(S, IDLE, DT).length === 0 && S.score[1] === 7);
}

/* ---------------- 4. 網子 ---------------- */
console.log('\n【4】網子擋球');
{
  const S = vvCreate();
  S.ball.live = true; S.ball.x = VOLLEY.NET_X - 20;
  S.ball.y = VOLLEY.NET_TOP + 50; S.ball.vx = 800; S.ball.vy = 0; S.ball.cool = 0;
  vvStep(S, IDLE, DT);
  ok('撞網後 vx 變號（往左彈）', S.ball.vx < 0, 'vx=' + S.ball.vx);
  ok('球被擋在網的左側', S.ball.x < VOLLEY.NET_X, 'x=' + S.ball.x);
  ok('網子反彈係數 0.6', Math.abs(S.ball.vx + 800 * 0.6) < 1e-6, 'vx=' + S.ball.vx);

  const S2 = vvCreate();
  S2.ball.live = true; S2.ball.x = VOLLEY.NET_X + 20;
  S2.ball.y = VOLLEY.NET_TOP + 50; S2.ball.vx = -800; S2.ball.vy = 0; S2.ball.cool = 0;
  vvStep(S2, IDLE, DT);
  ok('從右邊撞網也會彈回右側', S2.ball.vx > 0 && S2.ball.x > VOLLEY.NET_X);

  const S3 = vvCreate();                           // 高於網頂 → 可以飛過去
  S3.ball.live = true; S3.ball.x = VOLLEY.NET_X - 20;
  S3.ball.y = VOLLEY.NET_TOP - 40; S3.ball.vx = 800; S3.ball.vy = 0; S3.ball.cool = 0;
  vvStep(S3, IDLE, DT);
  ok('高於網頂不會被擋（vx 仍為正）', S3.ball.vx > 0 && S3.ball.x > VOLLEY.NET_X - 20);
}

/* ---------------- 5. 角色移動範圍 ---------------- */
console.log('\n【5】角色移動範圍');
{
  const S = vvCreate();
  const R0 = [{ l: false, r: true, u: false }, { l: false, r: false, u: false }];
  step(S, R0, 54);                                  // 0.9 秒往右（球還沒發）
  const nHi = VOLLEY.NET_X - VOLLEY.NET_W / 2 - VOLLEY.PW / 2;
  ok('P1 往右被夾在網前（不能過網）', Math.abs(S.P[0].x - nHi) < 1e-9, `x=${S.P[0].x} 上限=${nHi}`);

  const S2 = vvCreate();
  const L1 = [{ l: false, r: false, u: false }, { l: true, r: false, u: false }];
  step(S2, L1, 54);
  const nLo = VOLLEY.NET_X + VOLLEY.NET_W / 2 + VOLLEY.PW / 2;
  ok('P2 往左被夾在網後', Math.abs(S2.P[1].x - nLo) < 1e-9, `x=${S2.P[1].x} 下限=${nLo}`);

  const S3 = vvCreate();
  step(S3, [{ l: true, r: false, u: false }, { l: false, r: true, u: false }], 54);
  ok('P1 不能出左界', S3.P[0].x >= VOLLEY.PW / 2 + 8 - 1e-9, 'x=' + S3.P[0].x);
  ok('P2 不能出右界', S3.P[1].x <= VOLLEY.W - VOLLEY.PW / 2 - 8 + 1e-9, 'x=' + S3.P[1].x);

  const S4 = vvCreate();
  vvStep(S4, [{ l: false, r: false, u: true }, { l: false, r: false, u: false }], DT);
  /* 跳躍與重力在同一帧內發生（原程式就是這樣）：vy = -720 + 1500*dt */
  ok('P1 跳躍：離地、vy = -720 + GAC*dt',
     S4.P[0].onGround === false &&
     Math.abs(S4.P[0].vy - (-VOLLEY.JUMP + VOLLEY.GAC * DT)) < 1e-9,
     `onGround=${S4.P[0].onGround} vy=${S4.P[0].vy}`);
}

/* ---------------- 6. 決定性：同輸入跑兩次結果一致 ---------------- */
console.log('\n【6】決定性');
{
  const run = () => {
    const S = vvCreate();
    const evs = [];
    for (let i = 0; i < 900; i++) {
      const a = { l: i % 11 < 3, r: i % 11 >= 3 && i % 11 < 7, u: i % 37 === 0 };
      const b = { l: i % 13 < 4, r: i % 13 >= 4 && i % 13 < 9, u: i % 41 === 0 };
      evs.push(...vvStep(S, [a, b], DT));
    }
    return { S: JSON.stringify(S), evs: JSON.stringify(evs) };
  };
  const A1 = run(), A2 = run();
  ok('同一組輸入跑兩次：狀態完全一致', A1.S === A2.S);
  ok('同一組輸入跑兩次：事件序列完全一致', A1.evs === A2.evs);
  const SA = JSON.parse(A1.S);
  ok('900 幀後有產生分數（模擬真的打到球）', SA.score[0] + SA.score[1] > 0, JSON.stringify(SA.score));
  ok('沒有 NaN 座標', Number.isFinite(SA.ball.x) && Number.isFinite(SA.ball.y) &&
     Number.isFinite(SA.P[0].x) && Number.isFinite(SA.P[1].x));
}

/* ---------------- 結果 ---------------- */
console.log('\n' + results.join('\n'));
console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
process.exit(fail ? 1 : 0);
