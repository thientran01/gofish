# 🃏 Card Night · Live

Real-time multiplayer card games for **2–6 players** — pick a game, create a
table, share the 4-letter code, and play in the browser (phone or desktop).

**Games:** 🎣 **Go Fish** · 🃏 **Crazy Eights** · 🎯 **31** (Scat). Switch
between them with the tab on the home screen.

**Play:** pick a game → create a table → share the code/link → friends join →
host starts. Every game has an in-app **How to play** panel.

## Features
- Authoritative server-side engine — hidden hands stay hidden (each player only
  ever receives their own cards over the wire).
- **Go Fish:** ask for ranks, collect books. **Crazy Eights:** match suit/rank,
  wild 8s. **31:** build the best single-suit total, knock, lives & elimination —
  with a live score readout and a round-end reveal so new players learn by seeing.
- Reconnect-friendly: your seat is held if you drop, and disconnects never stall
  the table (turns auto-skip; the host can end early).
- Emoji reactions, a live game log, and a per-game leaderboard keyed by device
  identity (two players sharing a name stay separate).
- Mobile-first, responsive, installable (PWA).

## Tech
- **Node + Express + Socket.IO** — one game-agnostic service serves the client
  and runs every game (`server.js` + `cards.js`, `gofish.js`, `crazy8s.js`,
  `thirty_one.js`).
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
