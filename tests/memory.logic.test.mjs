/**
 * 翻牌配對「純邏輯」測試（09A）
 * 手法同 volley/ox：切出 index.html 的 MEMORY 邏輯區塊在 Node 跑。
 */
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('/* ===== MEMORY 邏輯 BEGIN');
const b = html.indexOf('/* ===== MEMORY 邏輯 END ===== */');
if (a < 0 || b < 0) throw new Error('找不到 MEMORY 邏輯區塊標記');
const src = html.slice(a, b);
const M = new Function(src + '\nreturn { MEM, memCreate, memCmd, memTick, memRng };')();
const { MEM, memCreate, memCmd, memTick } = M;

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '   → ' + e : '')); } };
const cf = (S, p) => memCmd(S, p, { a: 'confirm' });
function goTo(S, p, idx) {
  let guard = 0;
  const tx = idx % 4, ty = (idx / 4) | 0;
  while (S.cur[p].x !== tx && guard++ < 12) memCmd(S, p, { a: 'move', d: S.cur[p].x < tx ? 'right' : 'left' });
  while (S.cur[p].y !== ty && guard++ < 24) memCmd(S, p, { a: 'move', d: S.cur[p].y < ty ? 'down' : 'up' });
}
const pairsOf = (S) => {
  const m = {};
  S.deck.forEach((e, i) => { (m[e] = m[e] || []).push(i); });
  return m;
};

console.log('\n【1】牌堆');
{
  const S = memCreate(42);
  ok('16 張', S.deck.length === 16);
  const cnt = {};
  S.deck.forEach((e) => cnt[e] = (cnt[e] || 0) + 1);
  ok('8 種 emoji、每種 2 張', Object.keys(cnt).length === 8 && Object.values(cnt).every(v => v === 2), JSON.stringify(cnt));
  ok('決定性：同 seed 兩次一樣', memCreate(42).deck.join() === memCreate(42).deck.join());
  ok('不同 seed 不同牌堆', memCreate(1).deck.join() !== memCreate(2).deck.join());
  ok('初始：全蓋著、沒人得分、P1 先手',
    S.flip.every(v => v === 0) && S.gone.every(v => v === 0) && S.sc[0] === 0 && S.turn === 0);
}

console.log('\n【2】配對成功');
{
  const S = memCreate(7);
  const P = pairsOf(S);
  const [i0, i1] = P[S.deck[0]];
  goTo(S, 0, i0); let r = cf(S, 0);
  ok('翻第一張 → flip 事件、翻開', r.ok && r.ev[0].t === 'flip' && S.flip[i0] === 1, JSON.stringify(r));
  ok('第一張還不算得分、回合沒換', S.sc[0] === 0 && S.turn === 0);
  goTo(S, 0, i1); r = cf(S, 0);
  ok('翻到同一對 → match 事件、+1 分', r.ok && r.ev.some(e => e.t === 'match') && S.sc[0] === 1, JSON.stringify(r));
  ok('配對成功 → 上鎖（保持翻開）', S.lock === 1 && S.lockT > 0.9);
  ok('回合沒有換人（配對成功可以繼續翻）', S.turn === 0);
  ok('配對成功那一刻還沒消失', S.gone[i0] === 0 && S.flip[i1] === 1);
  let ev = memTick(S, 0.5);
  ok('0.5 秒時還在（保持 1 秒）', S.gone[i0] === 0 && S.lock === 1 && ev.length === 0, JSON.stringify(ev));
  ev = memTick(S, 0.6);
  ok('1.0 秒後 → 兩張消失（gone=1）', S.gone[i0] === 1 && S.gone[i1] === 1 && ev.some(e => e.t === 'vanish'), JSON.stringify(ev));
  ok('消失後解鎖', S.lock === 0);
}

console.log('\n【3】配錯');
{
  const S = memCreate(9);
  const P = pairsOf(S);
  // 找兩張不同 emoji 的
  const i0 = 0, i1 = S.deck.findIndex((e, i) => i > 0 && e !== S.deck[0]);
  goTo(S, 0, i0); cf(S, 0);
  goTo(S, 0, i1); const r = cf(S, 0);
  ok('配錯 → miss 事件、不上分', r.ok && r.ev.some(e => e.t === 'miss') && S.sc[0] === 0, JSON.stringify(r));
  ok('配錯先鎖 0.8 秒（還看得到兩張）', S.lock === 1 && S.flip[i0] === 1 && S.flip[i1] === 1);
  let ev = memTick(S, 0.4);
  ok('0.4 秒時還沒翻回', S.flip[i0] === 1 && ev.length === 0);
  ev = memTick(S, 0.45);
  ok('0.8 秒後兩張翻回、換手給 P2',
    S.flip[i0] === 0 && S.flip[i1] === 0 && S.turn === 1 && ev.some(e => e.t === 'back'), JSON.stringify(ev));
}

console.log('\n【4】回合鎖');
{
  const S = memCreate(11);
  const before = JSON.stringify(S);
  const r = cf(S, 1);
  ok('非當前玩家按確認 → ok:false、not-turn', !r.ok && r.why === 'not-turn', JSON.stringify(r));
  ok('狀態完全沒變', JSON.stringify(S) === before);
  for (let i = 0; i < 10; i++) cf(S, 1);
  ok('連送 10 次非法指令 → 一張都沒翻', S.flip.every(v => v === 0) && S.moves === 0);
  ok('非當前玩家也不能動游標', (() => {
    const b4 = JSON.stringify(S.cur);
    memCmd(S, 1, { a: 'move', d: 'up' });
    return JSON.stringify(S.cur) === b4;
  })());
  // 上鎖期間誰都不能翻
  goTo(S, 0, 0); cf(S, 0);
  const S2 = memCreate(12); goTo(S2, 0, 0); cf(S2, 0); goTo(S2, 0, 1); cf(S2, 0);   // 製造 lock
  const r3 = cf(S2, S2.turn);
  ok('上鎖期間 → ok:false、locked', !r3.ok && r3.why === 'locked', JSON.stringify(r3));
}

console.log('\n【5】全部配完');
{
  // 手動把 7 對設成已消失，只留最後一對
  const S = memCreate(3);
  const P = pairsOf(S);
  const last = S.deck[0], pair = P[last];
  S.deck.forEach((e, i) => { if (e !== last) S.gone[i] = 1; });
  S.sc[0] = 3; S.sc[1] = 4; S.turn = 1;
  goTo(S, 1, pair[0]); cf(S, 1);
  goTo(S, 1, pair[1]); cf(S, 1);
  ok('最後一組配對成功 → sc[1]=5', S.sc[1] === 5);
  memTick(S, 1.1);
  ok('全部消失 → over=true、winner=1', S.over === true && S.winner === 1, JSON.stringify({ o: S.over, w: S.winner }));

  // 平手
  const T = memCreate(4);
  const TP = pairsOf(T);
  const l2 = T.deck[0];
  T.deck.forEach((e, i) => { if (e !== l2) T.gone[i] = 1; });
  T.sc[0] = 3; T.sc[1] = 4; T.turn = 0;     // 最後一對給 P1 → 4:4 平手
  goTo(T, 0, TP[l2][0]); cf(T, 0);
  goTo(T, 0, TP[l2][1]); cf(T, 0);
  memTick(T, 1.1);
  ok('同分 → winner = -1（平手）', T.over === true && T.winner === -1, JSON.stringify({ sc: T.sc, w: T.winner }));
  ok('結束後指令一律被拒', cf(T, 0).ok === false);
}

console.log('\n【6】決定性');
{
  const run = () => {
    const S = memCreate(55);
    const out = [];
    const seq = [0, 1, 2, 5, 8, 9, 12, 13];
    for (const idx of seq) { goTo(S, 0, idx); const r = cf(S, 0); out.push(r.ok + ':' + (r.ev || []).map(e => e.t).join(',')); memTick(S, 1.2); }
    return JSON.stringify({ S, out });
  };
  ok('同指令序列跑兩次完全一致', run() === run());
}

console.log('\n==============================================');
console.log(`通過 ${pass} ／ 失敗 ${fail} ／ 共 ${pass + fail}`);
console.log('==============================================');
process.exit(fail ? 1 : 0);
