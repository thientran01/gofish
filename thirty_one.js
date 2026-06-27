// thirty_one.js — authoritative "31" (a.k.a. Scat / Blitz) engine.
// Each player holds 3 cards and 3 lives. Your score = the highest total of one
// suit in your hand (A=11, face/10=10, else pip); three of a kind = 30.5; 31 is
// the max. On your turn: draw one (stock or discard) then discard one — or KNOCK
// (no draw) to trigger one last turn for everyone, after which the lowest hand
// loses a life. Hit 31 and the round ends at once: everyone else loses a life.
// Lose all 3 lives and you're out. Last player standing wins.
const { SUITS, SUIT_NAMES, buildDeck, shuffle, sortHand, GameError } = require('./cards');

function cardValue(rank) {
  if (rank === 'A') return 11;
  if (rank === 'K' || rank === 'Q' || rank === 'J' || rank === '10') return 10;
  return parseInt(rank, 10);
}
// Best single-suit total; three of a kind = 30.5.
function handScore(hand) {
  if (hand.length === 3 && hand[0].rank === hand[1].rank && hand[1].rank === hand[2].rank) {
    return { score: 30.5, suit: null, trips: true };
  }
  let best = 0, bestSuit = SUITS[0];
  for (const su of SUITS) {
    const sum = hand.filter((c) => c.suit === su).reduce((s, c) => s + cardValue(c.rank), 0);
    if (sum > best) { best = sum; bestSuit = su; }
  }
  return { score: best, suit: bestSuit, trips: false };
}

class ThirtyOneGame {
  constructor(opts = {}) {
    this.gameType = 'thirtyone';
    this.rng = opts.rng || Math.random;
    this.players = []; // {id, token, name, hand:[], lives, eliminated, connected, isHost}
    this.stock = [];
    this.discard = [];
    this.turnIndex = 0;
    this.turnPhase = 'draw'; // 'draw' | 'discard'
    this.drawnId = null;     // card just drawn this turn (highlight hint)
    this.knockerId = null;
    this.finalTurnsLeft = 0;
    this.roundNum = 0;
    this.starterPtr = 0;     // rotates the first actor each round
    this.reveal = null;      // between-rounds reveal payload
    this.phase = 'lobby';    // lobby | playing | finished
    this.log = [];
    this.winnerIds = [];
    this.startedAt = null;
    this.endedAt = null;
    this.version = 0;
    this._idSeq = 0;
    this.startingLives = 3;
  }

  // ---- players -------------------------------------------------------------
  getPlayer(id) { return this.players.find((p) => p.id === id) || null; }
  getPlayerByToken(token) { return this.players.find((p) => p.token === token) || null; }
  currentPlayer() { return this.players[this.turnIndex] || null; }
  activePlayers() { return this.players.filter((p) => !p.eliminated); }

  addPlayer({ token, name }) {
    const existing = this.getPlayerByToken(token);
    if (existing) { existing.connected = true; return existing; }
    if (this.phase !== 'lobby') throw new GameError('Game already in progress — wait for the next match.');
    if (this.players.length >= 6) throw new GameError('Room is full (max 6 players).');
    const clean = String(name || '').trim().slice(0, 16) || `Player ${this.players.length + 1}`;
    const player = {
      id: 'pl_' + (++this._idSeq), token, name: clean,
      hand: [], lives: this.startingLives, eliminated: false,
      connected: true, isHost: this.players.length === 0,
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
    if (removed.isHost && this.players.length > 0) this.players[0].isHost = true;
    if (this.turnIndex >= this.players.length) this.turnIndex = 0;
    this.version++;
  }

  setConnected(id, connected) {
    const p = this.getPlayer(id);
    if (!p || p.connected === connected) return;
    p.connected = connected;
    this.pushLog('system', `${p.name} ${connected ? 'reconnected' : 'disconnected'}.`);
    this.version++;
    if (!connected && this.phase === 'playing' && !this.reveal) {
      const cur = this.currentPlayer();
      if (cur && cur.id === id) this.skipDisconnected();
    }
  }

  // ---- lifecycle -----------------------------------------------------------
  start(byId) {
    if (this.phase === 'playing') throw new GameError('Game already started.');
    if (this.players.length < 2) throw new GameError('Need at least 2 players to start.');
    const host = this.players.find((p) => p.isHost);
    if (host && byId && host.id !== byId) throw new GameError('Only the host can start the game.');
    for (const p of this.players) { p.lives = this.startingLives; p.eliminated = false; p.hand = []; }
    this.roundNum = 0;
    this.starterPtr = 0;
    this.phase = 'playing';
    this.winnerIds = [];
    this.startedAt = Date.now();
    this.endedAt = null;
    this.pushLog('system', 'Match on! Each player has 3 lives. Highest single-suit total is safe.');
    this.startRound();
    this.version++;
  }

  rematch(byId) {
    const host = this.players.find((p) => p.isHost);
    if (host && byId && host.id !== byId) throw new GameError('Only the host can start a rematch.');
    this.phase = 'lobby';
    this.stock = []; this.discard = []; this.reveal = null;
    this.knockerId = null; this.finalTurnsLeft = 0; this.winnerIds = [];
    for (const p of this.players) { p.hand = []; p.lives = this.startingLives; p.eliminated = false; }
    this.pushLog('system', 'Back to the lobby for a rematch.');
    this.version++;
  }

  forceEnd(byId) {
    const host = this.players.find((p) => p.isHost);
    if (host && byId && host.id !== byId) throw new GameError('Only the host can end the game.');
    if (this.phase !== 'playing') throw new GameError('No game in progress.');
    this.pushLog('system', 'The host ended the match early.');
    const alive = this.activePlayers();
    const max = Math.max(0, ...alive.map((p) => p.lives));
    this.winnerIds = alive.filter((p) => p.lives === max).map((p) => p.id);
    this.finishMatch();
  }

  startRound() {
    this.roundNum++;
    const active = this.activePlayers();
    this.stock = shuffle(buildDeck(), this.rng);
    for (const p of this.players) p.hand = [];
    for (let n = 0; n < 3; n++) for (const p of active) p.hand.push(this.stock.pop());
    this.discard = [this.stock.pop()];
    this.knockerId = null;
    this.finalTurnsLeft = 0;
    this.reveal = null;
    this.drawnId = null;
    // choose starter: rotate to next active player
    const order = this.players;
    let idx = this.starterPtr % order.length;
    for (let i = 0; i < order.length; i++) { if (!order[idx].eliminated) break; idx = (idx + 1) % order.length; }
    this.starterPtr = (idx + 1) % order.length;
    this.turnIndex = idx;
    this.pushLog('round', `— Round ${this.roundNum} — ${this.players[idx].name} starts. Top of discard: ${this.cardName(this.discardTop())}.`);
    this.beginTurn();
    this.version++;
  }

  // ---- per-turn flow -------------------------------------------------------
  discardTop() { return this.discard[this.discard.length - 1]; }
  cardName(c) { return c ? `${c.rank}${({S:'♠',H:'♥',D:'♦',C:'♣'})[c.suit]}` : '—'; }

  beginTurn() {
    if (this.phase !== 'playing' || this.reveal) return;
    const cur = this.currentPlayer();
    if (!cur) return;
    if (cur.eliminated) { this.advance(); return; }
    if (!cur.connected) { this.skipDisconnected(); return; }
    this.turnPhase = 'draw';
    this.drawnId = null;
    // Instant 31 — declare immediately at turn start.
    if (handScore(cur.hand).score === 31) { this.endRound('31', cur.id); }
  }

  skipDisconnected() {
    // Skip the current disconnected player's turn (still consumes a knock final turn).
    let guard = 0;
    while (guard++ <= this.players.length + 1) {
      const cur = this.currentPlayer();
      if (cur && !cur.eliminated && cur.connected) { this.beginTurn(); return; }
      if (cur && !cur.eliminated && !cur.connected) {
        this.pushLog('system', `${cur.name} is away — turn skipped.`);
      }
      this.advance(true);
      if (this.reveal || this.phase !== 'playing') return;
    }
    // no connected active player — wait for a reconnect
  }

  move(playerId, m) {
    if (!m || typeof m !== 'object') throw new GameError('Invalid move.');
    if (m.type === 'next_round') return this.nextRound(playerId);
    if (this.reveal) throw new GameError('Round over — start the next round.');
    if (m.type === 'draw') return this.draw(playerId, m.from);
    if (m.type === 'discard') return this.discard_(playerId, m.cardId);
    if (m.type === 'knock') return this.knock(playerId);
    throw new GameError('Unknown move.');
  }

  assertTurn(playerId) {
    if (this.phase !== 'playing') throw new GameError('The game is not in progress.');
    const cur = this.currentPlayer();
    if (!cur || cur.id !== playerId) throw new GameError("It's not your turn.");
    return cur;
  }

  draw(playerId, from) {
    const cur = this.assertTurn(playerId);
    if (this.turnPhase !== 'draw') throw new GameError('You already drew — now discard a card.');
    let card;
    if (from === 'discard') {
      if (!this.discard.length) throw new GameError('The discard pile is empty.');
      card = this.discard.pop();
    } else {
      if (this.stock.length === 0) this.reshuffle();
      if (this.stock.length === 0) throw new GameError('No cards left to draw.');
      card = this.stock.pop();
    }
    cur.hand.push(card);
    this.drawnId = card.id;
    this.turnPhase = 'discard';
    this.pushLog('draw', `${cur.name} drew from the ${from === 'discard' ? 'discard' : 'deck'}.`);
    this.version++;
  }

  discard_(playerId, cardId) {
    const cur = this.assertTurn(playerId);
    if (this.turnPhase !== 'discard') throw new GameError('Draw a card first.');
    const idx = cur.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) throw new GameError("You don't have that card.");
    const [card] = cur.hand.splice(idx, 1);
    this.discard.push(card);
    this.drawnId = null;
    this.pushLog('play', `${cur.name} discarded the ${this.cardName(card)}.`);
    this.version++;
    if (handScore(cur.hand).score === 31) { this.endRound('31', cur.id); return; }
    this.advance();
  }

  knock(playerId) {
    const cur = this.assertTurn(playerId);
    if (this.turnPhase !== 'draw') throw new GameError('You can only knock at the start of your turn.');
    if (this.knockerId) throw new GameError('Someone already knocked.');
    this.knockerId = cur.id;
    this.finalTurnsLeft = this.activePlayers().length - 1;
    this.pushLog('knock', `✊ ${cur.name} knocked! Everyone else gets one last turn.`);
    this.version++;
    if (this.finalTurnsLeft <= 0) { this.endRound('knock'); return; }
    this.advance();
  }

  reshuffle() {
    if (this.discard.length <= 1) return;
    const top = this.discard.pop();
    const rest = this.discard;
    this.discard = [top];
    this.stock = shuffle(rest, this.rng);
    this.pushLog('system', 'Reshuffled the pile.');
  }

  nextActiveIndex(from) {
    let i = from;
    for (let n = 0; n < this.players.length; n++) {
      i = (i + 1) % this.players.length;
      if (!this.players[i].eliminated) return i;
    }
    return from;
  }

  advance(skipping) {
    if (this.reveal || this.phase !== 'playing') return;
    if (this.knockerId) {
      if (this.finalTurnsLeft <= 0) { this.endRound('knock'); return; }
      this.finalTurnsLeft--;
    }
    this.turnIndex = this.nextActiveIndex(this.turnIndex);
    if (!skipping) this.beginTurn();
    else { /* skip path calls beginTurn via its own loop */ }
  }

  // ---- round / match resolution -------------------------------------------
  endRound(reason, declarerId) {
    const active = this.activePlayers();
    const scored = active.map((p) => {
      const hs = handScore(p.hand);
      return { id: p.id, name: p.name, score: hs.score, suit: hs.suit, trips: hs.trips, hand: sortHand(p.hand) };
    });
    let losers;
    if (reason === '31') {
      losers = active.filter((p) => p.id !== declarerId).map((p) => p.id);
      this.pushLog('win', `🎉 ${this.getPlayer(declarerId).name} hit 31! Everyone else loses a life.`);
    } else {
      const min = Math.min(...scored.map((s) => s.score));
      losers = scored.filter((s) => s.score === min).map((s) => s.id);
      const names = losers.map((id) => this.getPlayer(id).name).join(' & ');
      this.pushLog('round', `Lowest hand (${min}) — ${names} lose${losers.length > 1 ? '' : 's'} a life.`);
    }
    const eliminatedNow = [];
    for (const id of losers) {
      const p = this.getPlayer(id);
      p.lives -= 1;
      if (p.lives <= 0) { p.lives = 0; p.eliminated = true; eliminatedNow.push(id); this.pushLog('round', `💀 ${p.name} is out!`); }
    }
    const remaining = this.activePlayers();
    const matchOver = remaining.length <= 1;
    this.reveal = {
      reason, declarerId: declarerId || null,
      scores: scored,
      losers,
      eliminatedNow,
      lives: this.players.map((p) => ({ id: p.id, lives: p.lives, eliminated: p.eliminated })),
      matchOver,
      winnerIds: matchOver ? (remaining.length === 1 ? [remaining[0].id] : eliminatedNow) : [],
    };
    this.version++;
  }

  nextRound(playerId) {
    if (!this.reveal) throw new GameError('No round to advance.');
    if (this.reveal.matchOver) {
      this.winnerIds = this.reveal.winnerIds.slice();
      this.finishMatch();
      return;
    }
    this.reveal = null;
    this.startRound();
  }

  finishMatch() {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    this.reveal = null;
    this.endedAt = Date.now();
    if (!this.winnerIds.length) {
      const alive = this.activePlayers();
      this.winnerIds = alive.map((p) => p.id);
    }
    const names = this.players.filter((p) => this.winnerIds.includes(p.id)).map((p) => p.name);
    if (names.length === 1) this.pushLog('win', `🏆 ${names[0]} wins the match!`);
    else if (names.length) this.pushLog('win', `🏆 It's a tie: ${names.join(' & ')}.`);
    this.version++;
  }

  // ---- persistence ---------------------------------------------------------
  standings() {
    return this.players.map((p) => ({
      token: p.token, name: p.name, score: p.lives, won: this.winnerIds.includes(p.id),
    }));
  }

  pushLog(type, text) {
    this.log.push({ type, text, t: this.log.length });
    if (this.log.length > 200) this.log.shift();
  }

  // ---- views ---------------------------------------------------------------
  publicPlayers() {
    return this.players.map((p, i) => ({
      id: p.id, name: p.name, handCount: p.hand.length,
      lives: p.lives, eliminated: p.eliminated,
      connected: p.connected, isHost: p.isHost,
      isTurn: this.phase === 'playing' && !this.reveal && i === this.turnIndex && !p.eliminated,
      knocked: this.knockerId === p.id,
    }));
  }

  getStateFor(playerId) {
    const you = this.getPlayer(playerId);
    const cur = this.currentPlayer();
    const isYourTurn = this.phase === 'playing' && !this.reveal && cur && cur.id === playerId && you && !you.eliminated;
    const hs = you ? handScore(you.hand) : { score: 0, suit: null, trips: false };
    let reveal = null;
    if (this.reveal) {
      reveal = {
        reason: this.reveal.reason,
        declarerId: this.reveal.declarerId,
        scores: this.reveal.scores,     // includes each player's hand + score
        losers: this.reveal.losers,
        eliminatedNow: this.reveal.eliminatedNow,
        lives: this.reveal.lives,
        matchOver: this.reveal.matchOver,
      };
    }
    return {
      gameType: this.gameType,
      version: this.version,
      phase: this.phase,
      roundNum: this.roundNum,
      players: this.publicPlayers(),
      you: you ? {
        id: you.id, name: you.name, isHost: you.isHost,
        hand: sortHand(you.hand), lives: you.lives, eliminated: you.eliminated,
        score: hs.score, bestSuit: hs.suit, trips: hs.trips, drawnId: this.drawnId,
      } : null,
      turnId: cur ? cur.id : null,
      isYourTurn,
      turnPhase: isYourTurn ? this.turnPhase : null,
      canDraw: !!(isYourTurn && this.turnPhase === 'draw'),
      mustDiscard: !!(isYourTurn && this.turnPhase === 'discard'),
      canKnock: !!(isYourTurn && this.turnPhase === 'draw' && !this.knockerId),
      stockCount: this.stock.length,
      discardTop: this.discard.length ? this.discardTop() : null,
      knockerId: this.knockerId,
      finalTurnsLeft: this.knockerId ? this.finalTurnsLeft : null,
      reveal,
      winnerIds: this.winnerIds,
      log: this.log.slice(-40),
    };
  }

  // Conservation check for tests (within a round; eliminated hold no cards).
  cardCount() {
    let n = this.stock.length + this.discard.length;
    for (const p of this.players) n += p.hand.length;
    return n;
  }
}

module.exports = { ThirtyOneGame, handScore, cardValue };
