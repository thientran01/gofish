// gofish.js — authoritative Go Fish engine (pure logic, no I/O).
// Standard rules, 2–6 players. Suits are cosmetic; rank drives all logic.

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs

const RANK_NAMES = {
  A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King',
};
function rankLabel(rank) {
  return RANK_NAMES[rank] || rank;
}
function rankPlural(rank) {
  const base = rankLabel(rank);
  return base.endsWith('6') || base.endsWith('x') ? base + 'es' : base + 's';
}

class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameError';
    this.isGameError = true;
  }
}

function buildDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push({ rank, suit, id: rank + suit });
    }
  }
  return deck;
}

function shuffle(arr, rng) {
  const random = rng || Math.random;
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

const RANK_ORDER = RANKS.reduce((acc, r, i) => { acc[r] = i; return acc; }, {});
function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    if (RANK_ORDER[a.rank] !== RANK_ORDER[b.rank]) return RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
    return a.suit.localeCompare(b.suit);
  });
}

class GoFishGame {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.players = []; // {id, name, hand:[], books:[], connected, isHost}
    this.deck = [];
    this.turnIndex = 0;
    this.phase = 'lobby'; // lobby | playing | finished
    this.log = [];
    this.winnerIds = [];
    this.lastAsk = null; // {askerId, targetId, rank, count} — UI animation hint
    this.startedAt = null;
    this.endedAt = null;
    this.version = 0; // bumped on every mutation
  }

  // ---- player management ----------------------------------------------------
  getPlayer(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  currentPlayer() {
    return this.players[this.turnIndex] || null;
  }

  addPlayer({ id, name }) {
    const existing = this.getPlayer(id);
    if (existing) {
      existing.connected = true;
      return existing;
    }
    if (this.phase !== 'lobby') throw new GameError('Game already in progress — wait for the next round.');
    if (this.players.length >= 6) throw new GameError('Room is full (max 6 players).');
    const clean = String(name || '').trim().slice(0, 16) || `Player ${this.players.length + 1}`;
    const player = {
      id,
      name: clean,
      hand: [],
      books: [],
      connected: true,
      isHost: this.players.length === 0,
    };
    this.players.push(player);
    this.pushLog('system', `${player.name} joined the table.`);
    this.version++;
    return player;
  }

  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const [removed] = this.players.splice(idx, 1);
    this.pushLog('system', `${removed.name} left.`);
    if (removed.isHost && this.players.length > 0) {
      this.players[0].isHost = true;
    }
    if (this.turnIndex >= this.players.length) this.turnIndex = 0;
    this.version++;
  }

  setConnected(id, connected) {
    const p = this.getPlayer(id);
    if (!p) return;
    if (p.connected !== connected) {
      p.connected = connected;
      this.pushLog('system', `${p.name} ${connected ? 'reconnected' : 'disconnected'}.`);
      this.version++;
      if (!connected && this.phase === 'playing') {
        // Don't stall the table on a disconnect during someone's turn.
        this.ensurePlayable();
      }
    }
  }

  // ---- lifecycle ------------------------------------------------------------
  start(byId) {
    if (this.phase === 'playing') throw new GameError('Game already started.');
    if (this.players.length < 2) throw new GameError('Need at least 2 players to start.');
    const host = this.players.find((p) => p.isHost);
    if (host && byId && host.id !== byId) throw new GameError('Only the host can start the game.');

    this.deck = shuffle(buildDeck(), this.rng);
    for (const p of this.players) {
      p.hand = [];
      p.books = [];
    }
    const dealCount = this.players.length <= 3 ? 7 : 5;
    for (let n = 0; n < dealCount; n++) {
      for (const p of this.players) p.hand.push(this.deck.pop());
    }
    for (const p of this.players) this.checkBooks(p);
    this.turnIndex = 0;
    this.phase = 'playing';
    this.winnerIds = [];
    this.startedAt = Date.now();
    this.endedAt = null;
    this.lastAsk = null;
    this.pushLog('system', `Game on! ${this.players[0].name} goes first.`);
    this.version++;
    this.ensurePlayable();
  }

  rematch(byId) {
    const host = this.players.find((p) => p.isHost);
    if (host && byId && host.id !== byId) throw new GameError('Only the host can start a rematch.');
    this.phase = 'lobby';
    this.deck = [];
    this.winnerIds = [];
    this.lastAsk = null;
    for (const p of this.players) {
      p.hand = [];
      p.books = [];
    }
    this.pushLog('system', 'Back to the lobby for a rematch.');
    this.version++;
  }

  // ---- core move: ask -------------------------------------------------------
  ask(askerId, targetId, rank) {
    if (this.phase !== 'playing') throw new GameError('The game is not in progress.');
    const asker = this.currentPlayer();
    if (!asker || asker.id !== askerId) throw new GameError("It's not your turn.");
    const target = this.getPlayer(targetId);
    if (!target) throw new GameError('That player is not at the table.');
    if (target.id === asker.id) throw new GameError("You can't ask yourself.");
    if (target.hand.length === 0) throw new GameError(`${target.name} has no cards to ask for.`);
    if (!RANKS.includes(rank)) throw new GameError('Invalid rank.');
    if (!asker.hand.some((c) => c.rank === rank)) {
      throw new GameError(`You must hold a ${rankLabel(rank)} to ask for one.`);
    }

    const taken = target.hand.filter((c) => c.rank === rank);
    this.lastAsk = { askerId, targetId, rank, count: taken.length };

    if (taken.length > 0) {
      target.hand = target.hand.filter((c) => c.rank !== rank);
      asker.hand.push(...taken);
      this.pushLog('take', `${asker.name} took ${taken.length} ${rankPlural(rank)} from ${target.name}.`);
      const booked = this.checkBooks(asker);
      for (const b of booked) this.pushLog('book', `📚 ${asker.name} completed a book of ${rankPlural(b)}!`);
      this.version++;
      this.afterMove({ turnPasses: false });
      return { result: 'take', taken: taken.length, booked, from: target.id, rank };
    }

    // Go Fish
    this.pushLog('fish', `${asker.name} asked ${target.name} for ${rankPlural(rank)} — Go Fish! 🎣`);
    let drewMatch = false;
    let drawn = null;
    let booked = [];
    if (this.deck.length > 0) {
      drawn = this.deck.pop();
      asker.hand.push(drawn);
      booked = this.checkBooks(asker);
      if (drawn.rank === rank) {
        drewMatch = true;
        this.pushLog('lucky', `🍀 ${asker.name} fished exactly the ${rankLabel(rank)} they wanted — go again!`);
      }
      for (const b of booked) this.pushLog('book', `📚 ${asker.name} completed a book of ${rankPlural(b)}!`);
    }
    this.version++;
    this.afterMove({ turnPasses: !drewMatch });
    return { result: 'fish', drewMatch, drawnRank: drawn ? drawn.rank : null, booked, rank, target: target.id };
  }

  // Voluntary draw — only legal when no opponent has any cards but the pool does.
  draw(playerId) {
    if (this.phase !== 'playing') throw new GameError('The game is not in progress.');
    const cur = this.currentPlayer();
    if (!cur || cur.id !== playerId) throw new GameError("It's not your turn.");
    if (this.deck.length === 0) throw new GameError('The pool is empty.');
    if (this.opponentsHaveCards(cur)) throw new GameError('Ask a player who has cards instead of drawing.');
    const drawn = this.deck.pop();
    cur.hand.push(drawn);
    this.pushLog('draw', `${cur.name} drew from the pool.`);
    const booked = this.checkBooks(cur);
    for (const b of booked) this.pushLog('book', `📚 ${cur.name} completed a book of ${rankPlural(b)}!`);
    this.version++;
    this.afterMove({ turnPasses: true });
  }

  forceEnd(byId) {
    const host = this.players.find((p) => p.isHost);
    if (host && byId && host.id !== byId) throw new GameError('Only the host can end the game.');
    if (this.phase !== 'playing') throw new GameError('No game in progress.');
    this.pushLog('system', 'The host ended the game early.');
    this.finalize();
  }

  // ---- helpers --------------------------------------------------------------
  checkBooks(player) {
    const counts = {};
    for (const c of player.hand) counts[c.rank] = (counts[c.rank] || 0) + 1;
    const formed = [];
    for (const rank of RANKS) {
      if (counts[rank] === 4) {
        formed.push(rank);
        player.hand = player.hand.filter((c) => c.rank !== rank);
        player.books.push(rank);
      }
    }
    return formed;
  }

  opponentsHaveCards(player) {
    return this.players.some((p) => p.id !== player.id && p.hand.length > 0);
  }

  nextIndex(i) {
    if (this.players.length === 0) return 0;
    return (i + 1) % this.players.length;
  }

  booksFormed() {
    return this.players.reduce((sum, p) => sum + p.books.length, 0);
  }

  naturalEnd() {
    // Every card has been booked, or the pool is empty and all hands are empty.
    if (this.booksFormed() === RANKS.length) return true;
    if (this.deck.length === 0 && this.players.every((p) => p.hand.length === 0)) return true;
    return false;
  }

  anyConnectedCanAct() {
    if (this.deck.length > 0) {
      return this.players.some((p) => p.connected);
    }
    // pool empty: a connected player can act only if they have cards AND an opponent has cards
    return this.players.some(
      (p) => p.connected && p.hand.length > 0 && this.opponentsHaveCards(p)
    );
  }

  afterMove({ turnPasses }) {
    if (this.naturalEnd()) {
      this.finalize();
      return;
    }
    if (turnPasses) this.turnIndex = this.nextIndex(this.turnIndex);
    this.ensurePlayable();
  }

  // Make sure the current seat is a connected player who can actually move,
  // auto-drawing or skipping as needed. Finalizes if nobody can act.
  ensurePlayable() {
    if (this.phase !== 'playing') return;
    let guard = 0;
    const limit = this.players.length * 3 + 10;
    while (true) {
      if (++guard > limit) { this.finalize(); return; }
      if (this.naturalEnd() || !this.anyConnectedCanAct()) { this.finalize(); return; }

      const cur = this.players[this.turnIndex];
      if (!cur || !cur.connected) {
        this.turnIndex = this.nextIndex(this.turnIndex);
        continue;
      }
      if (cur.hand.length === 0) {
        if (this.deck.length > 0) {
          const c = this.deck.pop();
          cur.hand.push(c);
          this.pushLog('draw', `${cur.name} had no cards and drew from the pool.`);
          this.checkBooks(cur);
          this.version++;
          return; // cur can now act
        }
        this.turnIndex = this.nextIndex(this.turnIndex);
        continue;
      }
      // cur is connected with cards
      if (this.deck.length === 0 && !this.opponentsHaveCards(cur)) {
        // can't ask anyone and can't draw — game is effectively over
        this.finalize();
        return;
      }
      return; // ready for cur to move (ask, or draw if no opponents have cards)
    }
  }

  finalize() {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    this.endedAt = Date.now();
    const max = Math.max(0, ...this.players.map((p) => p.books.length));
    this.winnerIds = max > 0 ? this.players.filter((p) => p.books.length === max).map((p) => p.id) : [];
    const names = this.players.filter((p) => this.winnerIds.includes(p.id)).map((p) => p.name);
    if (names.length === 0) {
      this.pushLog('system', 'Game over.');
    } else if (names.length === 1) {
      this.pushLog('win', `🏆 ${names[0]} wins with ${max} books!`);
    } else {
      this.pushLog('win', `🏆 It's a tie between ${names.join(' & ')} with ${max} books each!`);
    }
    this.version++;
  }

  pushLog(type, text) {
    this.log.push({ type, text, t: this.log.length });
    if (this.log.length > 200) this.log.shift();
  }

  // ---- views ----------------------------------------------------------------
  publicPlayers() {
    return this.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      books: p.books.slice(),
      bookCount: p.books.length,
      connected: p.connected,
      isHost: p.isHost,
      isTurn: this.phase === 'playing' && i === this.turnIndex,
    }));
  }

  getStateFor(playerId) {
    const you = this.getPlayer(playerId);
    const cur = this.currentPlayer();
    const isYourTurn = this.phase === 'playing' && cur && cur.id === playerId;
    const askableRanks = you ? [...new Set(sortHand(you.hand).map((c) => c.rank))] : [];
    const canDraw = !!(isYourTurn && this.deck.length > 0 && you && !this.opponentsHaveCards(you));
    return {
      version: this.version,
      phase: this.phase,
      deckCount: this.deck.length,
      totalBooks: this.booksFormed(),
      turnId: cur ? cur.id : null,
      players: this.publicPlayers(),
      you: you
        ? {
            id: you.id,
            name: you.name,
            isHost: you.isHost,
            hand: sortHand(you.hand),
            books: you.books.slice(),
          }
        : null,
      isYourTurn,
      canDraw,
      askableRanks,
      lastAsk: this.lastAsk,
      winnerIds: this.winnerIds,
      log: this.log.slice(-40),
    };
  }

  // Conservation invariant — used by tests and a server-side sanity assert.
  cardCount() {
    let n = this.deck.length;
    for (const p of this.players) n += p.hand.length + p.books.length * 4;
    return n;
  }
}

module.exports = { GoFishGame, GameError, buildDeck, shuffle, sortHand, RANKS, SUITS, rankLabel, rankPlural };
