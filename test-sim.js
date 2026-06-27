// test-sim.js — fuzz the engine: play thousands of random valid games to
// completion and assert invariants. Run: node test-sim.js
const { GoFishGame, RANKS } = require('./gofish');

// Deterministic-ish RNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function legalMoves(game) {
  const cur = game.currentPlayer();
  const moves = [];
  if (!cur) return moves;
  const ranks = [...new Set(cur.hand.map((c) => c.rank))];
  const targets = game.players.filter((p) => p.id !== cur.id && p.hand.length > 0);
  for (const t of targets) for (const r of ranks) moves.push({ kind: 'ask', targetId: t.id, rank: r });
  if (game.deck.length > 0 && !game.opponentsHaveCards(cur)) moves.push({ kind: 'draw' });
  return moves;
}

function assert(cond, msg, ctx) {
  if (!cond) {
    console.error('ASSERT FAIL:', msg, ctx ? JSON.stringify(ctx) : '');
    process.exit(1);
  }
}

const GAMES = 4000;
let totalTurns = 0;
let naturalEnds = 0;
let stalledFinals = 0;
const bookDist = {};

for (let g = 0; g < GAMES; g++) {
  const rng = mulberry32(g + 1);
  const game = new GoFishGame({ rng });
  const nPlayers = 2 + Math.floor(rng() * 5); // 2..6
  for (let i = 0; i < nPlayers; i++) game.addPlayer({ id: 'p' + i, name: 'P' + i });
  game.start('p0');
  assert(game.cardCount() === 52, 'card conservation after deal', { g });

  let steps = 0;
  while (game.phase === 'playing') {
    if (++steps > 5000) assert(false, 'game did not terminate', { g, steps });
    const moves = legalMoves(game);
    if (moves.length === 0) {
      // Engine should never leave a connected player with no legal move while playing.
      assert(false, 'no legal moves but still playing', {
        g, deck: game.deck.length, turn: game.currentPlayer() && game.currentPlayer().id,
        hands: game.players.map((p) => p.hand.length),
      });
    }
    const m = moves[Math.floor(rng() * moves.length)];
    const before = game.cardCount();
    if (m.kind === 'ask') game.ask(game.currentPlayer().id, m.targetId, m.rank);
    else game.draw(game.currentPlayer().id);
    assert(game.cardCount() === 52, 'card conservation after move', { g, before, after: game.cardCount() });
    // No hand should ever contain 4 of a kind (books auto-form).
    for (const p of game.players) {
      const counts = {};
      for (const c of p.hand) counts[c.rank] = (counts[c.rank] || 0) + 1;
      for (const r of RANKS) assert((counts[r] || 0) < 4, 'unbooked 4-of-a-kind', { g, player: p.id, r });
    }
    totalTurns++;
  }

  // Final assertions
  assert(game.phase === 'finished', 'phase finished', { g });
  const totalBooks = game.players.reduce((s, p) => s + p.books.length, 0);
  assert(game.cardCount() === 52, 'card conservation at end', { g });
  bookDist[totalBooks] = (bookDist[totalBooks] || 0) + 1;
  if (totalBooks === 13) naturalEnds++; else stalledFinals++;

  // Winner has the max books.
  const max = Math.max(...game.players.map((p) => p.books.length));
  if (max > 0) {
    for (const id of game.winnerIds) assert(game.getPlayer(id).books.length === max, 'winner has max books', { g });
    for (const p of game.players) {
      if (p.books.length === max) assert(game.winnerIds.includes(p.id), 'all top players are winners', { g });
    }
  }
}

console.log(`OK — ${GAMES} games, ${totalTurns} total turns.`);
console.log(`Natural ends (13 books): ${naturalEnds}, other terminations: ${stalledFinals}`);
console.log('Total-books distribution at end:', JSON.stringify(bookDist));

// Targeted edge case: disconnect mid-game must not stall.
(function disconnectTest() {
  const rng = mulberry32(999);
  const game = new GoFishGame({ rng });
  for (let i = 0; i < 4; i++) game.addPlayer({ id: 'd' + i, name: 'D' + i });
  game.start('d0');
  game.setConnected('d1', false);
  game.setConnected('d2', false);
  let steps = 0;
  while (game.phase === 'playing') {
    if (++steps > 5000) { console.error('disconnect test stalled'); process.exit(1); }
    const moves = legalMoves(game);
    if (moves.length === 0) { console.error('disconnect: no legal move while playing'); process.exit(1); }
    const m = moves[Math.floor(rng() * moves.length)];
    if (m.kind === 'ask') game.ask(game.currentPlayer().id, m.targetId, m.rank);
    else game.draw(game.currentPlayer().id);
    assert(game.cardCount() === 52, 'disconnect card conservation', {});
    // Disconnected players should be skipped, never become the active turn.
    assert(game.currentPlayer().connected, 'active player is connected', { turn: game.currentPlayer().id });
  }
  console.log('OK — disconnect test passed (no stall, disconnected players skipped).');
})();

console.log('All tests passed.');
