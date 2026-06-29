// test-switch.js — verifies the party-likes easter egg: 👍 from the room toggles 31 <-> Crazy 8s.
// Drives two real socket.io clients, spams 👍 to the threshold, and asserts the game flips both
// ways with seats preserved (the re-seating after the engine swap) and no hand leaks.
// Usage: node test-switch.js [port]
const { io } = require('socket.io-client');

const PORT = process.argv[2] || 3000;
const URL = `http://localhost:${PORT}`;
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mk = (i) => ({ i, pid: 'sw_' + i + '_' + Math.random().toString(36).slice(2), name: 'Bot' + i, sock: io(URL, { transports: ['websocket'] }) });

(async () => {
  const a = mk(0), b = mk(1);
  for (const c of [a, b]) {
    c.sock.on('state', (s) => {
      c.state = s;
      if (s && s.you) for (const p of s.players) if (p.id !== s.you.id && 'hand' in p) fail('opponent hand leaked');
    });
    c.sock.on('error_msg', (m) => console.warn(`[bot${c.i}] ${m}`));
  }

  await new Promise((r) => a.sock.on('connect', r));
  let code;
  await new Promise((r) => a.sock.emit('create_room', { name: a.name, pid: a.pid, game: 'thirtyone' }, (res) => {
    if (!res || !res.ok) fail('create_room: ' + (res && res.error));
    if (res.game !== 'thirtyone') fail('expected thirtyone, got ' + res.game);
    code = res.code; r();
  }));
  if (!b.sock.connected) await new Promise((r) => b.sock.on('connect', r));
  await new Promise((r) => b.sock.emit('join_room', { code, name: b.name, pid: b.pid }, (res) => {
    if (!res || !res.ok) fail('join_room: ' + (res && res.error)); r();
  }));
  await sleep(180);
  if (a.state.gameType !== 'thirtyone') fail('expected to start in 31, got ' + a.state.gameType);
  console.log('OK  started in 31 — room', code);

  async function spamUntil(target, label) {
    for (let round = 0; round < 40; round++) {
      a.sock.emit('react', { emoji: '👍' });
      b.sock.emit('react', { emoji: '👍' });
      await sleep(340); // > REACT_COOLDOWN_MS so each 👍 counts
      if (a.state.gameType === target && b.state.gameType === target) return round + 1;
    }
    fail(`never switched to ${target} (${label}) — stuck at ${a.state.gameType}`);
  }

  await spamUntil('crazy8s', 'first flip');
  if (!a.state.you || !b.state.you) fail('a player lost their seat after the switch (you missing → re-seating broke)');
  if (a.state.phase !== 'playing') fail('expected auto-start (playing) after switch, got ' + a.state.phase);
  console.log('OK  flipped 31 → Crazy 8s, auto-started, both seats intact');

  await spamUntil('thirtyone', 'flip back');
  if (!a.state.you || !b.state.you) fail('a player lost their seat on the flip back');
  console.log('OK  flipped Crazy 8s → 31 (toggles both ways)');

  a.sock.close(); b.sock.close();
  console.log('All switch checks passed.');
  process.exit(0);
})();

setTimeout(() => fail('switch test timed out (40s)'), 40000);
