// server.js — realtime Go Fish room server.
// Express serves the client + a leaderboard API; Socket.IO runs the live game.
// The server holds all authoritative state and sends each player only their
// own hand (hidden-hand integrity).
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { GoFishGame, GameError } = require('./gofish');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/leaderboard', async (_req, res) => {
  res.json({ leaderboard: await db.getLeaderboard(10), persistence: db.enabled });
});

// ---- room registry ----------------------------------------------------------
/** code -> { game, createdAt, recorded } */
const rooms = new Map();

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
  const sockets = io.sockets.adapter.rooms.get(code);
  if (!sockets) return;
  for (const sid of sockets) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    s.emit('state', room.game.getStateFor(s.data.pid));
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
  socket.data.pid = null;
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

  socket.on('create_room', guard(({ name, pid }, cb) => {
    const code = makeCode();
    const game = new GoFishGame();
    rooms.set(code, { game, createdAt: Date.now(), recorded: false });
    const player = game.addPlayer({ id: pid, name });
    socket.data.pid = pid;
    socket.data.code = code;
    socket.join(code);
    ack(cb, { ok: true, code, you: { id: player.id, name: player.name } });
    broadcast(code);
  }));

  socket.on('join_room', guard(({ code, name, pid }, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) throw new GameError('No room with that code.');
    const player = room.game.addPlayer({ id: pid, name }); // throws if mid-game & new
    socket.data.pid = pid;
    socket.data.code = code;
    socket.join(code);
    ack(cb, { ok: true, code, you: { id: player.id, name: player.name } });
    broadcast(code);
  }));

  socket.on('start_game', guard((_payload, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    room.game.start(socket.data.pid);
    ack(cb, { ok: true });
    broadcast(socket.data.code);
  }));

  socket.on('ask', guard(({ targetId, rank }, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    room.game.ask(socket.data.pid, targetId, rank);
    ack(cb, { ok: true });
    broadcast(socket.data.code);
    maybeRecord(socket.data.code);
  }));

  socket.on('draw', guard((_payload, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    room.game.draw(socket.data.pid);
    ack(cb, { ok: true });
    broadcast(socket.data.code);
    maybeRecord(socket.data.code);
  }));

  socket.on('end_game', guard((_payload, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    room.game.forceEnd(socket.data.pid);
    ack(cb, { ok: true });
    broadcast(socket.data.code);
    maybeRecord(socket.data.code);
  }));

  socket.on('rematch', guard((_payload, cb) => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new GameError('You are not in a room.');
    room.game.rematch(socket.data.pid);
    room.recorded = false;
    ack(cb, { ok: true });
    broadcast(socket.data.code);
  }));

  // Ephemeral emoji reactions — fun, not part of game state.
  socket.on('react', ({ emoji }) => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const player = room.game.getPlayer(socket.data.pid);
    if (!player) return;
    const safe = String(emoji || '').slice(0, 4);
    io.to(socket.data.code).emit('reaction', { from: player.name, fromId: player.id, emoji: safe });
  });

  socket.on('leave', guard((_payload, cb) => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (room && room.game.phase === 'lobby') {
      room.game.removePlayer(socket.data.pid);
      broadcast(code);
    }
    socket.leave(code);
    socket.data.code = null;
    ack(cb, { ok: true });
  }));

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room) return;
    // Only mark disconnected if no other socket for this pid remains in the room.
    const sockets = io.sockets.adapter.rooms.get(code);
    let stillHere = false;
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.id !== socket.id && s.data.pid === socket.data.pid) { stillHere = true; break; }
      }
    }
    if (!stillHere) {
      room.game.setConnected(socket.data.pid, false);
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
    const ageHours = (now - room.createdAt) / 3600000;
    if (live === 0 && ageHours > 2) rooms.delete(code);
    else if (ageHours > 12) rooms.delete(code);
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎣 Go Fish server listening on :${PORT}`));
