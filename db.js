// db.js — Supabase persistence over PostgREST (plain fetch, no SDK).
// Generic across games: a match-history row + a per-(game, player_key)
// leaderboard, written through SECURITY DEFINER RPCs. Works on Node >= 18.
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const enabled = !!(URL && KEY);

if (enabled) console.log('[db] Supabase persistence enabled.');
else console.warn('[db] SUPABASE_URL / SUPABASE_KEY not set — running without persistence.');

async function rpc(fn, body) {
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${fn} ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : null;
}

// players: [{ key, name, score, won }]
async function recordGame({ game, roomCode, players, durationSeconds }) {
  if (!enabled) return;
  try {
    await rpc('card_record_game', {
      p_game: game,
      p_room: roomCode,
      p_players: players,
      p_duration: Math.max(0, Math.round(durationSeconds || 0)),
    });
  } catch (e) {
    console.error('[db] recordGame failed:', e.message);
  }
}

async function getLeaderboard(game, limit = 10) {
  if (!enabled) return [];
  try {
    const data = await rpc('card_get_leaderboard', { p_game: game, p_limit: limit });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[db] getLeaderboard failed:', e.message);
    return [];
  }
}

module.exports = { recordGame, getLeaderboard, enabled };
