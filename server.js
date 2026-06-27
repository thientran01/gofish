// server.js — realtime Go Fish room server.
// Express serves the client + a leaderboard API; Socket.IO runs the live game.
// The server holds all authoritative state and sends each player only their
// own hand (hidden-hand integrity). A socket's seat is bound server-side via a
// private reconnect token; only public ids are ever broadcast.
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { GoFishGame, GameError } = require('./gofish');
const db = require('./db');

const app = express();
const server = http.createServer(app);
// Legitimate payloads are tiny; cap the buffer to blunt oversized-payload abuse.
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 16 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/leaderboard', async (_req, res) => {
  res.json({ leaderboard: await db.getLeaderboard(10), persistence: db.enabled });
});

// ---- room registry ----------------------------------------------------------
/** code -> { game, createdAt, lastActivity, recorded } */
const rooms = new Map();
const MAX_ROOMS = 2000;
const CREATE_COOLDOWN_MS = 2000;
const REACT_COOLDOWN_MS = 400;

const isStr = (v) => typeof v === 'string';
function reqToken(pid) {
  if (!isStr(pid) || pid.length < 4 || pid.length > 128) throw new GameError('Invalid session.');
}
function capName(name) {
  if (name != null && (!isStr(name) || name.length > 64)) throw new GameError('Invalid name.');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}

function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.lastActivity = Date.now();
  const sockets = io.sockets.adapter.rooms.get(code);
  if (!sockets) return;
  for (const sid of sockets) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    s.emit('state', room.game.getStateFor(s.data.id));
  }
}

async function maybeRecord(code) {
  const room = rooms.get(code);
  if (!room || room.recorded || room.game.phase !== 'finished') return;
  room.recorded = true;
  const g = room.game;
  const winners = g.players.filter((p) => g.winnerIds.includes(p.id)).map((p) => p.name);
  await db.recordGame({
    roomCode: code,
    players: g.players.map((p) => ({ name: p.name, books: p.books.length })),
    winners,
    durationSeconds: g.startedAt ? (g.endedAt - g.startedAt) / 1000 : 0,
  });
}

// ---- socket handlers --------------------------------------------------------
function ack(cb, payload) {
  if (typeof cb === 'function') cb(payload);
}

io.on('connection', (socket) => {
  socket.data.token = null;
  socket.data.id = null;
  socket.data.code = null;

  const guard = (fn) => async (...args) => {
    const cb = args[args.length - 1];
    try {
      await fn(...args);
    } catch (e) {
      const msg = e && e.isGameError ? e.message : 'Something went wrong.';
      if (!(e && e.isGameError)) console.error('[socket] error:', e);
      if (typeof cb === 'function') ack(cb, { ok: false, error: msg });
      else socket.emit('error_msg', msg);
    }
  };

  socket.on('create_room', guard(({ name, pid } = {}, cb) => {
    reqToken(pid);
    capName(name);
    const now = Date.now();
    if (socket.data.lastCreate && now - socket.data.lastCreate < CREATE_COOLDOWN_MS) {
      throw new GameError('Slow down a moment, then try again.');
    }
    if (rooms.size >= MAX_ROOMS) throw new GameError('Server is busy — try again shortly.');
    socket.data.lastCreate = now;
    const code = makeCode();
    const game = new GoFishGame();
    rooms.set(code, { game, createdAt: now, lastActivity: now, recorded: false });
    const player = game.addPlayer({ token: pid, name });
    socket.data.token = pid;
    socket.data.id = player.id;
    socket.data.code = code;
    socket.join(code);
    ack(cb, { ok: true, code, you: { id: player.id, name: player.name } });
    broadcast(code);
  }));

  socket.on('join_room', guard(({ code, name, pid } = {}, cb) => {
    reqToken(pid);
    capName(name);
    if (!isStr(code) || code.length > 8) throw new GameError('Invalid room code.');
    code = code.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) throw new GameError('No room with that code.');
    const player = room.game.addPlayer({ token: pid, name }); // throws if mid-game & new token
    socket.data.token = pid;
    socket.data.id = player.id;
    socket.data.code = code;
    socket.join(code);
    ack(cb, { ok: true, code, you: { id: player.id, name: player.name } });
    broadcast(code);
  }));

  socket.on('start_game', guard((_payload, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    room.game.start(socket.data.id);
    ack(cb, { ok: true });
    broadcast(socket.data.code);
  }));

  socket.on('ask', guard(({ targetId, rank } = {}, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    if (!isStr(targetId) || targetId.length > 32 || !isStr(rank) || rank.length > 4) {
      throw new GameError('Invalid move.');
    }
    room.game.ask(socket.data.id, targetId, rank);
    ack(cb, { ok: true });
    broadcast(socket.data.code);
    maybeRecord(socket.data.code);
  }));

  socket.on('draw', guard((_payload, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    room.game.draw(socket.data.id);
    ack(cb, { ok: true });
    broadcast(socket.data.code);
    maybeRecord(socket.data.code);
  }));

  socket.on('end_game', guard((_payload, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    room.game.forceEnd(socket.data.id);
    ack(cb, { ok: true });
    broadcast(socket.data.code);
    maybeRecord(socket.data.code);
  }));

  socket.on('rematch', guard((_payload, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    room.game.rematch(socket.data.id);
    room.recorded = false;
    ack(cb, { ok: true });
    broadcast(socket.data.code);
  }));

  // Ephemeral emoji reactions — fun, not part of game state. Rate-limited.
  socket.on('react', ({ emoji } = {}) => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const now = Date.now();
    if (socket.data.lastReact && now - socket.data.lastReact < REACT_COOLDOWN_MS) return;
    socket.data.lastReact = now;
    const player = room.game.getPlayer(socket.data.id);
    if (!player) return;
    const safe = isStr(emoji) ? emoji.slice(0, 8) : '';
    if (!safe) return;
    io.to(socket.data.code).emit('reaction', { from: player.name, fromId: player.id, emoji: safe });
  });

  socket.on('leave', guard((_payload, cb) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (room) {
      if (room.game.phase === 'lobby') room.game.removePlayer(socket.data.id);
      else {
        // Mid-game leave: free the seat so the table doesn't stall waiting on it.
        room.game.setConnected(socket.data.id, false);
        maybeRecord(code);
      }
      broadcast(code);
    }
    socket.leave(code);
    socket.data.code = null;
    socket.data.id = null;
    socket.data.token = null;
    ack(cb, { ok: true });
  }));

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room) return;
    // Only mark disconnected if no other socket for this token remains in the room.
    const sockets = io.sockets.adapter.rooms.get(code);
    let stillHere = false;
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.id !== socket.id && s.data.token === socket.data.token) { stillHere = true; break; }
      }
    }
    if (!stillHere) {
      room.game.setConnected(socket.data.id, false);
      broadcast(code);
      maybeRecord(code);
    }
  });
});

// ---- housekeeping: sweep idle/empty rooms -----------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const sockets = io.sockets.adapter.rooms.get(code);
    const live = sockets ? sockets.size : 0;
    const idleHours = (now - (room.lastActivity || room.createdAt)) / 3600000;
    const ageHours = (now - room.createdAt) / 3600000;
    if (live === 0 && idleHours > 2) rooms.delete(code);
    else if (ageHours > 12) rooms.delete(code);
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎣 Go Fish server listening on :${PORT}`));
