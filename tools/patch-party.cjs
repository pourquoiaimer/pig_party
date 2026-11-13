const fs = require('fs');
let s = fs.readFileSync('server/server.mjs', 'utf8').replace(/\r\n/g, '\n');
function rep(o, n, c) {
  const k = s.split(o).length - 1;
  if (k !== c) throw new Error('錨點 ' + k + ' != ' + c + ' :: ' + o.slice(0, 60));
  s = s.split(o).join(n);
}

/* ---------- 1. 把「建立比賽 + gstart + 首包」抽成函式 ---------- */
const oldStart = `        if (c.room.match && !c.room.match.over) return send(c, { t: 'err', msg: 'match already running' });
        try {
          c.room.match = (game === 'ox') ? newOxMatch()
                        : (game === 'memory') ? newMemoryMatch()
                        : (game === '2048') ? newMatch2048()
                        : (game === 'tug') ? newTugMatch()
                        : (game === 'race') ? newRaceMatch()
                        : (game === 'fruit') ? newFruitMatch()
                        : (game === 'splat') ? newSplatMatch()
                        : (game === 'fight') ? newFightMatch()
                        : (game === 'math') ? newMathMatch(String(m.mode || 'easy'))
                        : newMatch();
        }
        catch (e) { return send(c, { t: 'err', msg: game + ' unavailable' }); }
        c.room.lastActive = now();
        sendBoth(c.room, { t: 'gstart', game });
        if (game === 'ox') broadcastOx(c.room, []);        // 立刻送第一包，兩邊不用等心跳
        if (game === 'memory') { c.room.match.lastTick = now(); broadcastMem(c.room, []); }
        if (game === '2048') { c.room.match.lastBc = now(); broadcast2048(c.room, []); }
        if (game === 'tug') { c.room.match.lastBc = now(); c.room.match.lastPullAt = now(); broadcastTug(c.room, []); }
        if (game === 'race') { c.room.match.lastBc = now(); c.room.match.lastStep = now(); broadcastRace(c.room, []); }
        if (game === 'fruit') { c.room.match.lastBc = now(); c.room.match.lastStep = now(); broadcastFruit(c.room, []); }
        if (game === 'splat') { c.room.match.lastBc = now(); c.room.match.lastStep = now(); broadcastSplat(c.room, []); }
        if (game === 'fight') { c.room.match.lastBc = now(); c.room.match.lastStep = now(); broadcastFight(c.room, []); }
        if (game === 'math') { c.room.match.lastBc = now(); c.room.match.lastStep = now(); broadcastMath(c.room, []); }
        log('room', c.room.code, game, 'start');`;
const newStart = `        if (c.room.match && !c.room.match.over) return send(c, { t: 'err', msg: 'match already running' });
        c.room.party = null;                      // 手動開一場 → 取消派對流程
        if (!startGameIn(c.room, game, m.mode)) return send(c, { t: 'err', msg: game + ' unavailable' });`;
rep(oldStart, newStart, 1);

/* ---------- 2. startGameIn + 派對函式（放在 sendBoth 之後） ---------- */
const anchor = `function peerOf(c) {`;
const helper = `const PARTY_GAMES = ['volley', 'ox', 'memory', '2048', 'tug', 'race', 'fruit', 'splat', 'fight', 'math'];

/** 建立一場比賽並開賽（手動開賽與派對流程共用） */
function startGameIn(r, game, mode) {
  try {
    r.match = (game === 'ox') ? newOxMatch()
            : (game === 'memory') ? newMemoryMatch()
            : (game === '2048') ? newMatch2048()
            : (game === 'tug') ? newTugMatch()
            : (game === 'race') ? newRaceMatch()
            : (game === 'fruit') ? newFruitMatch()
            : (game === 'splat') ? newSplatMatch()
            : (game === 'fight') ? newFightMatch()
            : (game === 'math') ? newMathMatch(String(mode || 'easy'))
            : newMatch();
  } catch (e) { return false; }
  r.lastActive = now();
  sendBoth(r, { t: 'gstart', game });
  const m = r.match;
  if (game === 'ox') broadcastOx(r, []);
  if (game === 'volley') { m.lastBc = now(); }
  if (game === 'memory') { m.lastTick = now(); broadcastMem(r, []); }
  if (game === '2048') { m.lastBc = now(); broadcast2048(r, []); }
  if (game === 'tug') { m.lastBc = now(); m.lastPullAt = now(); broadcastTug(r, []); }
  if (game === 'race') { m.lastBc = now(); m.lastStep = now(); broadcastRace(r, []); }
  if (game === 'fruit') { m.lastBc = now(); m.lastStep = now(); broadcastFruit(r, []); }
  if (game === 'splat') { m.lastBc = now(); m.lastStep = now(); broadcastSplat(r, []); }
  if (game === 'fight') { m.lastBc = now(); m.lastStep = now(); broadcastFight(r, []); }
  if (game === 'math') { m.lastBc = now(); m.lastStep = now(); broadcastMath(r, []); }
  log('room', r.code, game, 'start' + (r.party ? ' (party ' + (r.party.idx + 1) + '/' + r.party.queue.length + ')' : ''));
  return true;
}

/** 派對：開下一關（或結束） */
function partyAdvance(r) {
  const p = r.party;
  if (!p) return;
  p.idx++;
  if (p.idx >= p.queue.length) {
    const w = p.wins;
    sendBoth(r, { t: 'partyEnd', wins: w, draw: p.draw, n: p.queue.length });
    log('room', r.code, 'party end', w.join(':'));
    r.party = null;
    return;
  }
  p.waitFrom = 0;
  sendBoth(r, { t: 'partyNext', idx: p.idx, n: p.queue.length, game: p.queue[p.idx], wins: p.wins });
  startGameIn(r, p.queue[p.idx], 'easy');
}

function peerOf(c) {`;
rep(anchor, helper, 1);

/* ---------- 3. 'party' 指令 ---------- */
rep(`      /* 大廳表情：純轉發（不記錄、不驗證內容，只限制索引範圍） */`,
`      /* 隨機派對：host 指定關卡數（測試可用 list 指定順序） */
      case 'party': {
        if (!c.room) return send(c, { t: 'err', msg: 'not in room' });
        if (c.role !== 'host') return send(c, { t: 'err', msg: 'only host can start' });
        if (c.room.match && !c.room.match.over) return send(c, { t: 'err', msg: 'match already running' });
        const n = Math.max(1, Math.min(9, Number(m.n) || 3));
        let queue = Array.isArray(m.list) ? m.list.map(String).filter((g) => PARTY_GAMES.indexOf(g) >= 0) : null;
        if (!queue || !queue.length) {
          const pool = PARTY_GAMES.slice();
          queue = [];
          for (let i = 0; i < n && pool.length; i++) {
            const k = crypto.randomInt(pool.length);
            queue.push(pool.splice(k, 1)[0]);
          }
        }
        c.room.party = { queue, idx: -1, wins: [0, 0], draw: 0, waitFrom: 0 };
        c.room.match = null;
        log('room', c.room.code, 'party', queue.join('>'));
        partyAdvance(c.room);
        break;
      }
      /* 大廳表情：純轉發（不記錄、不驗證內容，只限制索引範圍） */`, 1);

/* ---------- 4. tick：比賽結束後 4 秒自動下一關 ---------- */
rep(`const TICK_TIMER = setInterval(() => {
  const t = now();
  for (const r of rooms.values()) {
    const m = r.match;
    if (!m) continue;`,
`const TICK_TIMER = setInterval(() => {
  const t = now();
  for (const r of rooms.values()) {
    const m = r.match;
    /* 派對：這一關打完了 → 記勝場，4 秒後換下一關（或結束） */
    if (r.party && m && m.over) {
      if (!r.party.waitFrom) {
        r.party.waitFrom = t;
        const w = (typeof m.winner === 'number') ? m.winner : -1;
        if (w >= 0) r.party.wins[w]++; else r.party.draw++;
      } else if (t - r.party.waitFrom > 4000) {
        r.party.waitFrom = 0;
        partyAdvance(r);
      }
      continue;
    }
    if (!m) continue;`, 1);

fs.writeFileSync('server/server.mjs', s);
console.log('派對：startGameIn / partyAdvance / party 指令 / tick 自動換關 完成');
