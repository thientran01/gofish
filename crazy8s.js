// crazy8s.js — authoritative Crazy Eights engine (pure logic, no I/O).
// 2–6 players. Match the top card by rank or suit; 8s are wild and let you
// choose the next suit; first to empty their hand wins. On your turn you either
// play a legal card or draw one (which ends your turn).
const { RANKS, SUITS, SUIT_NAMES, rankLabel, GameError, buildDeck, shuffle, sortHand } = require('./cards');

class CrazyEightsGame {
  constructor(opts = {}) {
    this.gameType = 'crazy8s';
    this.rng = opts.rng || Math.random;
    this.players = []; // {id, token, name, hand:[], connected, isHost}
    this.stock = [];   // draw pile (pop = top)
    this.discard = []; // last element = top
    this.currentSuit = null; // suit that must be matched (may differ from top after an 8)
    this.turnIndex = 0;
    this.phase = 'lobby';
    this.log = [];
    this.winnerIds = [];
    this.lastPlay = null;
    this.startedAt = null;
    this.endedAt = null;
    this.version = 0;
    this._idSeq = 0;
  }

  // ---- players (identical identity model to Go Fish) ------------------------
  getPlayer(id) { return this.players.find((p) => p.id === id) || null; }
  getPlayerByToken(token) { return this.players.find((p) => p.token === token) || null; }
  currentPlayer() { return this.players[this.turnIndex] || null; }

  addPlayer({ token, name }) {
    const existing = this.getPlayerByToken(token);
    if (existing) { existing.connected = true; return existing; }
    if (this.phase !== 'lobby') throw new GameError('Game already in progress — wait for the next round.');
    if (this.players.length >= 6) throw new GameError('Room is full (max 6 players).');
    const clean = String(name || '').trim().slice(0, 16) || `Player ${this.players.length + 1}`;
    const player = {
      id: 'pl_' + (++this._idSeq), token, name: clean,
      hand: [], connected: true, isHost: this.players.length === 0,
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
    if (!connected && this.phase === 'playing') this.ensureActable();
  }

  // ---- lifecycle -----------------------------------------------------------
  start(byId) {
    if (this.phase === 'playing') throw new GameError('Game already started.');
    if (this.players.length < 2) throw new GameError('Need at least 2 players to start.');
    const host = this.players.find((p) => p.isHost);
    if (host && byId && host.id !== byId) throw new GameError('Only the host can start the game.');

    this.stock = shuffle(buildDeck(), this.rng);
    for (const p of this.players) p.hand = [];
    const dealCount = this.players.length === 2 ? 7 : 5;
    for (let n = 0; n < dealCount; n++) for (const p of this.players) p.hand.push(this.stock.pop());

    // Flip a starter that isn't an 8 (push any 8s to the bottom of the stock).
    let starter = this.stock.pop();
    while (starter.rank === '8') { this.stock.unshift(starter); starter = this.stock.pop(); }
    this.discard = [starter];
    this.currentSuit = starter.suit;

    this.turnIndex = 0;
    this.phase = 'playing';
    this.winnerIds = [];
    this.lastPlay = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.pushLog('system', `Game on! Top card is the ${rankLabel(starter.rank)} of ${SUIT_NAMES[starter.suit]}. ${this.players[0].name} goes first.`);
    this.version++;
    this.ensureActable();
  }

  rematch(byId) {
    const host = this.players.find((p) => p.isHost);
    if (host && byId && host.id !== byId) throw new GameError('Only the host can start a rematch.');
    this.phase = 'lobby';
    this.stock = []; this.discard = []; this.currentSuit = null;
    this.winnerIds = []; this.lastPlay = null;
    for (const p of this.players) p.hand = [];
    this.pushLog('system', 'Back to the lobby for a rematch.');
    this.version++;
  }

  forceEnd(byId) {
    const host = this.players.find((p) => p.isHost);
    if (host && byId && host.id !== byId) throw new GameError('Only the host can end the game.');
    if (this.phase !== 'playing') throw new GameError('No game in progress.');
    this.pushLog('system', 'The host ended the game early.');
    this.finalize();
  }

  // ---- moves ---------------------------------------------------------------
  move(playerId, m) {
    if (!m || typeof m !== 'object') throw new GameError('Invalid move.');
    if (m.type === 'play') return this.play(playerId, m.cardId, m.suit);
    if (m.type === 'draw') return this.draw(playerId);
    throw new GameError('Unknown move.');
  }

  discardTop() { return this.discard[this.discard.length - 1]; }

  isPlayable(card) {
    return card.rank === '8' || card.suit === this.currentSuit || card.rank === this.discardTop().rank;
  }

  hasPlayable(player) { return player.hand.some((c) => this.isPlayable(c)); }
  canDrawNow() { return this.stock.length > 0 || this.discard.length > 1; }
  canAct(player) { return this.hasPlayable(player) || this.canDrawNow(); }

  play(playerId, cardId, chosenSuit) {
    if (this.phase !== 'playing') throw new GameError('The game is not in progress.');
    const cur = this.currentPlayer();
    if (!cur || cur.id !== playerId) throw new GameError("It's not your turn.");
    const idx = cur.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) throw new GameError("You don't have that card.");
    const card = cur.hand[idx];
    if (!this.isPlayable(card)) {
      throw new GameError(`You can't play the ${rankLabel(card.rank)} of ${SUIT_NAMES[card.suit]} on the ${rankLabel(this.discardTop().rank)} of ${SUIT_NAMES[this.currentSuit]}.`);
    }
    if (card.rank === '8') {
      if (!SUITS.includes(chosenSuit)) throw new GameError('Choose a suit for your 8.');
      this.currentSuit = chosenSuit;
    } else {
      this.currentSuit = card.suit;
    }
    cur.hand.splice(idx, 1);
    this.discard.push(card);
    this.lastPlay = { playerId: cur.id, card, suit: this.currentSuit };
    if (card.rank === '8') this.pushLog('wild', `🎱 ${cur.name} played an 8 — suit is now ${SUIT_NAMES[this.currentSuit]}.`);
    else this.pushLog('play', `${cur.name} played the ${rankLabel(card.rank)} of ${SUIT_NAMES[card.suit]}.`);
    if (cur.hand.length === 1) this.pushLog('system', `⚠️ ${cur.name} has one card left!`);
    this.version++;

    if (cur.hand.length === 0) {
      this.pushLog('win', `🏆 ${cur.name} went out and wins!`);
      this.finalize();
      return { result: 'win' };
    }
    this.advanceTurn();
    return { result: 'play' };
  }

  draw(playerId) {
    if (this.phase !== 'playing') throw new GameError('The game is not in progress.');
    const cur = this.currentPlayer();
    if (!cur || cur.id !== playerId) throw new GameError("It's not your turn.");
    if (!this.canDrawNow()) {
      if (this.hasPlayable(cur)) throw new GameError('No cards left to draw — play a card.');
      this.pushLog('system', `${cur.name} can't move and passes.`);
      this.advanceTurn();
      return { result: 'pass' };
    }
    if (this.stock.length === 0) this.reshuffle();
    const c = this.stock.pop();
    cur.hand.push(c);
    this.pushLog('draw', `${cur.name} drew a card.`);
    this.version++;
    this.advanceTurn();
    return { result: 'draw' };
  }

  reshuffle() {
    if (this.discard.length <= 1) return;
    const top = this.discard.pop();
    const rest = this.discard;
    this.discard = [top];
    this.stock = shuffle(rest, this.rng);
    this.pushLog('system', 'Reshuffled the discard pile into the draw pile.');
  }

  // ---- turn flow -----------------------------------------------------------
  nextIndex(i) { return this.players.length ? (i + 1) % this.players.length : 0; }

  advanceTurn() {
    this.turnIndex = this.nextIndex(this.turnIndex);
    this.ensureActable();
  }

  // Skip disconnected or fully-stuck players; finalize if nobody can act.
  ensureActable() {
    if (this.phase !== 'playing') return;
    for (let i = 0; i < this.players.length; i++) {
      const cur = this.players[this.turnIndex];
      if (cur && cur.connected && this.canAct(cur)) return;
      this.turnIndex = this.nextIndex(this.turnIndex);
    }
    this.finalize();
  }

  finalize() {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    this.endedAt = Date.now();
    const min = Math.min(...this.players.map((p) => p.hand.length));
    this.winnerIds = this.players.filter((p) => p.hand.length === min).map((p) => p.id);
    const names = this.players.filter((p) => this.winnerIds.includes(p.id)).map((p) => p.name);
    if (names.length === 1) this.pushLog('win', `🏆 ${names[0]} wins!`);
    else this.pushLog('win', `🏆 Tie between ${names.join(' & ')} (fewest cards).`);
    this.version++;
  }

  // ---- persistence ---------------------------------------------------------
  standings() {
    const winners = new Set(this.winnerIds);
    return this.players.map((p) => ({
      token: p.token,
      name: p.name,
      won: winners.has(p.id),
      // "domination" score: cards left in opponents' hands when you win.
      score: winners.has(p.id)
        ? this.players.reduce((s, q) => s + (q.id === p.id ? 0 : q.hand.length), 0)
        : 0,
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
      connected: p.connected, isHost: p.isHost,
      isTurn: this.phase === 'playing' && i === this.turnIndex,
    }));
  }

  getStateFor(playerId) {
    const you = this.getPlayer(playerId);
    const cur = this.currentPlayer();
    const isYourTurn = this.phase === 'playing' && cur && cur.id === playerId;
    const hand = you ? sortHand(you.hand) : [];
    return {
      gameType: this.gameType,
      version: this.version,
      phase: this.phase,
      players: this.publicPlayers(),
      you: you ? { id: you.id, name: you.name, isHost: you.isHost, hand } : null,
      turnId: cur ? cur.id : null,
      isYourTurn,
      drawPileCount: this.stock.length,
      discardTop: this.discard.length ? this.discardTop() : null,
      currentSuit: this.currentSuit,
      playableIds: isYourTurn ? hand.filter((c) => this.isPlayable(c)).map((c) => c.id) : [],
      canDraw: !!(isYourTurn && this.canDrawNow()),
      lastPlay: this.lastPlay,
      winnerIds: this.winnerIds,
      log: this.log.slice(-40),
    };
  }

  cardCount() {
    let n = this.stock.length + this.discard.length;
    for (const p of this.players) n += p.hand.length;
    return n;
  }
}

module.exports = { CrazyEightsGame };
