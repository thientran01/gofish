// cards.js — shared card primitives used by every game engine.
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs
const SUIT_NAMES = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_NAMES = { A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' };

function rankLabel(rank) { return RANK_NAMES[rank] || rank; }
function rankPlural(rank) { return rankLabel(rank) + 's'; }

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
    for (const suit of SUITS) deck.push({ rank, suit, id: rank + suit });
  }
  return deck;
}

function shuffle(arr, rng) {
  const random = rng || Math.random;
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

const RANK_ORDER = RANKS.reduce((acc, r, i) => { acc[r] = i; return acc; }, {});
function sortHand(hand) {
  return hand.slice().sort((a, b) =>
    RANK_ORDER[a.rank] !== RANK_ORDER[b.rank]
      ? RANK_ORDER[a.rank] - RANK_ORDER[b.rank]
      : SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
}

module.exports = {
  RANKS, SUITS, SUIT_NAMES, SUIT_SYM, RANK_NAMES,
  rankLabel, rankPlural, GameError, buildDeck, shuffle, sortHand,
};
