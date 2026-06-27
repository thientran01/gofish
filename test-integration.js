// test-integration.js — drive real socket.io clients through the live server for
// a given game, end to end (rooms, turns, hidden hands, finish, persistence).
// Usage: node test-integration.js [port] [gofish|crazy8s]
const { io } = require('socket.io-client');

const PORT = process.argv[2] || 3000;
const GAME = process.argv[3] || 'gofish';
const URL = `http://localhost:${PORT}`;
const N = 4;
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const SUITS = ['S', 'H', 'D', 'C'];

function mkClient(i) {
  return { i, pid: 'itp_' + GAME + '_' + i + '_' + Math.random().toString(36).slice(2), name: 'Bot' + i, sock: io(URL, { transports: ['websocket'] }), acted: -1 };
}

function legalMove(s) {
  if (!s || !s.isYourTurn) return null;
  if (s.gameType === 'thirtyone') {
    if (s.turnPhase === 'draw') {
      if (s.canKnock && Math.random() < 0.25) return { type: 'knock' };
      return { type: 'draw', from: (s.discardTop && Math.random() < 0.5) ? 'discard' : 'stock' };
    }
    if (s.turnPhase === 'discard') return { type: 'discard', cardId: rnd(s.you.hand).id };
    return null;
  }
  if (s.gameType === 'crazy8s') {
    const playable = s.you.hand.filter((c) => (s.playableIds || []).includes(c.id));
    if (playable.length && Math.random() < 0.85) {
      const c = rnd(playable);
      return { type: 'play', cardId: c.id, suit: c.rank === '8' ? rnd(SUITS) : undefined };
    }
    if (s.canDraw) return { type: 'draw' };
    return playable.length ? { type: 'play', cardId: playable[0].id, suit: playable[0].rank === '8' ? rnd(SUITS) : undefined } : { type: 'draw' };
  }
  // gofish
  if (s.canDraw) return { type: 'draw' };
  const ranks = [...new Set(s.you.hand.map((c) => c.rank))];
  const targets = s.players.filter((p) => p.id !== s.you.id && p.handCount > 0);
  if (!ranks.length || !targets.length) return null;
  return { type: 'ask', targetId: rnd(targets).id, rank: rnd(ranks) };
}

function fail(m) { console.error('FAIL:', m); process.exit(1); }

(async () => {
  const clients = Array.from({ length: N }, (_, i) => mkClient(i));
  let finished = false;
  const timeout = setTimeout(() => fail(`${GAME} did not finish within 45s`), 45000);

  function onState(c, s) {
    c.state = s;
    if (s.gameType !== GAME) fail(`expected gameType ${GAME}, got ${s.gameType}`);
    for (const p of s.players) if (p.id !== s.you.id && 'hand' in p) fail('opponent hand leaked');
    if (s.phase === 'finished' && !finished) {
      finished = true; clearTimeout(timeout);
      if (!s.winnerIds.length) fail('no winners at finish');
      console.log(`OK ${GAME} finished — winner(s): ${s.winnerIds.length}`);
      verifyPersistence();
      return;
    }
    // 31 between-rounds: the host advances to the next round
    if (s.gameType === 'thirtyone' && s.reveal && s.you && s.you.isHost && c.acted !== s.version) {
      c.acted = s.version;
      setTimeout(() => c.sock.emit('move', { move: { type: 'next_round' } }), 8);
      return;
    }
    if (s.phase === 'playing' && s.isYourTurn && c.acted !== s.version) {
      c.acted = s.version;
      const m = legalMove(s);
      if (m) setTimeout(() => c.sock.emit('move', { move: m }), 6);
    }
  }

  clients.forEach((c) => c.sock.on('state', (s) => onState(c, s)));
  clients.forEach((c) => c.sock.on('error_msg', (m) => console.warn(`[bot${c.i}] ${m}`)));

  await new Promise((res) => clients[0].sock.on('connect', res));
  let code = null;
  await new Promise((res) => clients[0].sock.emit('create_room', { name: clients[0].name, pid: clients[0].pid, game: GAME }, (r) => {
    if (!r || !r.ok) fail('create_room: ' + (r && r.error));
    if (r.game !== GAME) fail('room game mismatch: ' + r.game);
    code = r.code; res();
  }));
  console.log(`${GAME} room:`, code);

  for (let i = 1; i < N; i++) {
    const c = clients[i];
    if (!c.sock.connected) await new Promise((res) => c.sock.on('connect', res));
    await new Promise((res) => c.sock.emit('join_room', { code, name: c.name, pid: c.pid }, (r) => { if (!r || !r.ok) fail('join: ' + (r && r.error)); res(); }));
  }
  console.log(`${N} players joined`);
  clients[0].sock.emit('start_game', {}, (r) => { if (r && !r.ok) fail('start: ' + r.error); });

  function verifyPersistence() {
    setTimeout(() => {
      fetch(`${URL}/api/leaderboard?game=${GAME}`).then((r) => r.json()).then((d) => {
        if (!d.persistence) { console.log('NOTE: persistence disabled — skipping DB check.'); return cleanup(); }
        const bots = (d.leaderboard || []).filter((x) => x.name.startsWith('Bot'));
        if (!bots.length) fail('no Bot rows in leaderboard');
        console.log(`OK ${GAME} persistence — ${bots.length} bot rows`);
        cleanup();
      }).catch((e) => fail('leaderboard: ' + e.message));
    }, 600);
  }
  function cleanup() { clients.forEach((c) => c.sock.close()); console.log(`All ${GAME} integration checks passed.`); process.exit(0); }
})();
