// test-integration.js — drives N real socket.io clients through the live server
// to verify the realtime layer end-to-end (rooms, turns, hidden hands, finish).
// Usage: node test-integration.js [port]
const { io } = require('socket.io-client');

const PORT = process.argv[2] || 3000;
const URL = `http://localhost:${PORT}`;
const N = 4;

function mkClient(i) {
  const pid = 'itp_' + i + '_' + Math.random().toString(36).slice(2);
  const sock = io(URL, { transports: ['websocket'] });
  return { i, pid, name: 'Bot' + i, sock, state: null, acted: -1 };
}

function legalMove(s) {
  if (!s || !s.isYourTurn) return null;
  if (s.canDraw) return { kind: 'draw' };
  const ranks = [...new Set(s.you.hand.map((c) => c.rank))];
  const targets = s.players.filter((p) => p.id !== s.you.id && p.handCount > 0);
  if (!targets.length || !ranks.length) return null;
  const t = targets[Math.floor(Math.random() * targets.length)];
  const r = ranks[Math.floor(Math.random() * ranks.length)];
  return { kind: 'ask', targetId: t.id, rank: r };
}

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }

(async () => {
  const clients = Array.from({ length: N }, (_, i) => mkClient(i));
  let finished = false;

  const timeout = setTimeout(() => fail('game did not finish within 20s'), 20000);

  function onState(c, s) {
    c.state = s;
    // hidden-hand integrity: no opponent hand leaks
    for (const p of s.players) {
      if (p.id !== s.you.id && 'hand' in p) fail('opponent hand leaked to client ' + c.i);
    }
    if (s.phase === 'finished' && !finished) {
      finished = true;
      clearTimeout(timeout);
      const total = s.players.reduce((a, p) => a + p.bookCount, 0);
      if (!s.winnerIds.length) fail('no winners at finish');
      const max = Math.max(...s.players.map((p) => p.bookCount));
      for (const id of s.winnerIds) {
        const w = s.players.find((p) => p.id === id);
        if (w.bookCount !== max) fail('winner does not have max books');
      }
      console.log(`OK realtime game finished — ${total}/13 books, winner(s): ${s.winnerIds.length}`);
      verifyPersistence();
      return;
    }
    // act if it's my turn
    if (s.phase === 'playing' && s.isYourTurn && c.acted !== s.version) {
      c.acted = s.version;
      const m = legalMove(s);
      if (!m) return;
      setTimeout(() => {
        if (m.kind === 'draw') c.sock.emit('draw', {});
        else c.sock.emit('ask', { targetId: m.targetId, rank: m.rank });
      }, 5);
    }
  }

  clients.forEach((c) => c.sock.on('state', (s) => onState(c, s)));
  clients.forEach((c) => c.sock.on('error_msg', (m) => console.warn(`[bot${c.i}] err: ${m}`)));

  // connect host
  await new Promise((res) => clients[0].sock.on('connect', res));
  let code = null;
  await new Promise((res) =>
    clients[0].sock.emit('create_room', { name: clients[0].name, pid: clients[0].pid }, (r) => {
      if (!r || !r.ok) fail('create_room failed: ' + (r && r.error));
      code = r.code; res();
    })
  );
  console.log('room created:', code);

  // others join
  for (let i = 1; i < N; i++) {
    const c = clients[i];
    if (!c.sock.connected) await new Promise((res) => c.sock.on('connect', res));
    await new Promise((res) =>
      c.sock.emit('join_room', { code, name: c.name, pid: c.pid }, (r) => {
        if (!r || !r.ok) fail(`join failed for ${c.name}: ` + (r && r.error));
        res();
      })
    );
  }
  console.log(`${N} players joined`);

  // start
  clients[0].sock.emit('start_game', {}, (r) => { if (r && !r.ok) fail('start failed: ' + r.error); });

  function verifyPersistence() {
    setTimeout(() => {
      fetch(URL + '/api/leaderboard')
        .then((r) => r.json())
        .then((d) => {
          if (!d.persistence) { console.log('NOTE: persistence disabled (no Supabase env) — skipping DB check.'); cleanup(); return; }
          const bots = (d.leaderboard || []).filter((x) => x.name.startsWith('Bot'));
          if (!bots.length) fail('no Bot rows in leaderboard after game');
          console.log('OK persistence — leaderboard has', bots.length, 'bot rows:', JSON.stringify(bots));
          cleanup();
        })
        .catch((e) => fail('leaderboard fetch failed: ' + e.message));
    }, 600);
  }
  function cleanup() {
    clients.forEach((c) => c.sock.close());
    console.log('All integration checks passed.');
    process.exit(0);
  }
})();
