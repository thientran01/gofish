# 🎣 Go Fish · Live

Real-time multiplayer Go Fish for **2–6 players**. Create a table, share the
4-letter code, and play in the browser — phone or desktop.

**Play:** create a table → share the code/link → friends join → host starts.

## Features
- Authoritative server-side engine — hidden hands stay hidden (each player only
  ever receives their own cards over the wire).
- Live turn flow: tap a player, tap a rank, ask. Books, "Go Fish", lucky-draw
  go-agains, and auto-draw all handled to the standard rules.
- Reconnect-friendly: your seat is held if you drop, and disconnects never stall
  the table (the turn auto-skips; the host can also end early).
- Emoji reactions, a live game log, and a persistent cross-game leaderboard.
- Mobile-first, responsive card-table UI.

## Tech
- **Node + Express + Socket.IO** — one service serves the client and runs the
  realtime game (`server.js`, `gofish.js`).
- **Supabase (Postgres)** — match history + leaderboard, written server-side
  through `SECURITY DEFINER` RPCs over PostgREST. Tables are RLS-locked; the
  client never touches the database directly.
- Deployed on **Railway**.

## Run locally
```bash
npm install
npm start            # http://localhost:3000
```
Persistence is optional locally — set the env vars below to enable it.

## Tests
```bash
npm test                       # engine fuzz: thousands of random games + invariants
node test-integration.js 3000  # drives real socket clients through a full game
```

## Environment variables
| var | purpose |
|---|---|
| `PORT` | HTTP port (Railway sets this automatically) |
| `SUPABASE_URL` | Supabase project URL — enables leaderboard/history |
| `SUPABASE_KEY` | Supabase publishable/anon key (only has EXECUTE on two RPCs) |

If the Supabase vars are unset, the game runs fully — just without persistence.
