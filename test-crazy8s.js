// test-crazy8s.js — fuzz the Crazy Eights engine: thousands of random legal
// games to completion, asserting card conservation, termination, and winner
// correctness. Run: node test-crazy8s.js
const { CrazyEightsGame } = require('./crazy8s');
const { SUITS } = require('./cards');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function assert(c, m, ctx) { if (!c) { console.error('ASSERT FAIL:', m, ctx ? JSON.stringify(ctx) : ''); process.exit(1); } }

function chooseMove(game, rng) {
  const cur = game.currentPlayer();
  const playable = cur.hand.filter((c) => game.isPlayable(c));
  const canDraw = game.canDrawNow();
  if (playable.length && (rng() < 0.8 || !canDraw)) {
    const card = playable[Math.floor(rng() * playable.length)];
    return { type: 'play', cardId: card.id, suit: card.rank === '8' ? SUITS[Math.floor(rng() * 4)] : undefined };
  }
  return { type: 'draw' }; // engine draws, or passes if truly stuck
}

const GAMES = 5000;
let totalMoves = 0, wentOut = 0, deadlocks = 0;

for (let g = 0; g < GAMES; g++) {
  const rng = mulberry32(g + 1);
  const game = new CrazyEightsGame({ rng });
  const n = 2 + Math.floor(rng() * 5); // 2..6
  for (let i = 0; i < n; i++) game.addPlayer({ token: 'p' + i, name: 'P' + i });
  game.start();
  assert(game.cardCount() === 52, 'conservation after deal', { g });
  assert(game.discardTop().rank !== '8', 'starter is not an 8', { g });

  let steps = 0;
  while (game.phase === 'playing') {
    if (++steps > 20000) assert(false, 'did not terminate', { g });
    const cur = game.currentPlayer();
    assert(cur && cur.connected, 'current player connected', { g });
    const m = chooseMove(game, rng);
    game.move(cur.id, m);
    assert(game.cardCount() === 52, 'conservation after move', { g, after: game.cardCount() });
    // currentSuit always valid
    assert(SUITS.includes(game.currentSuit), 'valid current suit', { g });
    totalMoves++;
  }

  assert(game.phase === 'finished', 'finished', { g });
  assert(game.cardCount() === 52, 'conservation at end', { g });
  assert(game.winnerIds.length >= 1, 'has winner', { g });
  const min = Math.min(...game.players.map((p) => p.hand.length));
  for (const id of game.winnerIds) assert(game.getPlayer(id).hand.length === min, 'winner has fewest cards', { g });
  for (const p of game.players) if (p.hand.length === min) assert(game.winnerIds.includes(p.id), 'all fewest are winners', { g });
  if (min === 0) wentOut++; else deadlocks++;
}

console.log(`OK — ${GAMES} Crazy Eights games, ${totalMoves} moves.`);
console.log(`Someone went out (won with 0 cards): ${wentOut}, stuck-pile finishes: ${deadlocks}`);

// Targeted: 8 must require a suit; illegal plays rejected; disconnect skip.
(function unit() {
  const g = new CrazyEightsGame({ rng: mulberry32(7) });
  const a = g.addPlayer({ token: 'a', name: 'A' });
  const b = g.addPlayer({ token: 'b', name: 'B' });
  g.start();
  const cur = g.currentPlayer();
  // playing a card you don't have throws
  let threw = false; try { g.play(cur.id, 'ZZ'); } catch (e) { threw = e.isGameError; }
  assert(threw, 'play unknown card throws');
  // out-of-turn throws
  const other = g.players.find((p) => p.id !== cur.id);
  threw = false; try { g.play(other.id, other.hand[0].id); } catch (e) { threw = e.isGameError; }
  assert(threw, 'out-of-turn play throws');
  console.log('OK — Crazy Eights unit checks passed.');
})();

(function disconnectTest() {
  const g = new CrazyEightsGame({ rng: mulberry32(123) });
  const ps = [];
  for (let i = 0; i < 4; i++) ps.push(g.addPlayer({ token: 'd' + i, name: 'D' + i }));
  g.start();
  g.setConnected(ps[1].id, false);
  g.setConnected(ps[2].id, false);
  const rng = mulberry32(456);
  let steps = 0;
  while (g.phase === 'playing') {
    if (++steps > 20000) { console.error('disconnect stalled'); process.exit(1); }
    const cur = g.currentPlayer();
    assert(cur.connected, 'active player connected during disconnect test', { turn: cur.id });
    g.move(cur.id, chooseMove(g, rng));
    assert(g.cardCount() === 52, 'disconnect conservation');
  }
  console.log('OK — Crazy Eights disconnect test passed.');
})();

console.log('All Crazy Eights tests passed.');
