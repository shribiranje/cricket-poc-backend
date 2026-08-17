/**
 * Shared test harness.
 *
 * Boots the Express app in-process on an ephemeral port (no need to run
 * `npm run dev` alongside) and exposes a small fetch wrapper plus fixture
 * builders.
 *
 * Prerequisites:
 *   - MySQL reachable with the same .env the app uses
 *   - `npm run db:init` has been run (seeded teams/players + demo users)
 *
 * Tests only ever CREATE matches/users and purge what they created; the
 * seeded teams/players catalog is treated as read-only.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'; // silences morgan

const http = require('http');
const app = require('../src/app');
const pool = require('../src/config/db');

let server = null;
let baseUrl = '';

async function startApi() {
  if (server) return baseUrl;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  return baseUrl;
}

/** Close the HTTP server AND the MySQL pool, so the test process can exit. */
async function stopApi() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  await pool.end();
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json?.data, error: json?.error, raw: json };
}

async function login(username = 'demo', password = 'password123') {
  const r = await api('POST', '/auth/login', { body: { username, password } });
  if (!r.data?.token) throw new Error(`login failed for "${username}": ${JSON.stringify(r.raw)}`);
  return r.data.token;
}

/** Create a match via the admin API. Defaults: MI vs CSK, 1h from now, IST. */
async function createMatch(token, overrides = {}) {
  const body = {
    teamAId: 1,
    teamBId: 2,
    format: 'T20',
    venue: 'Test Ground',
    startTimeUtc: new Date(Date.now() + 3600_000).toISOString(),
    timezone: 'Asia/Kolkata',
    autoStart: true,
    ...overrides,
  };
  const r = await api('POST', '/admin/matches', { token, body });
  if (!r.data?.id) throw new Error(`createMatch failed: ${JSON.stringify(r.raw)}`);
  return r.data.id;
}

/**
 * Remove a match and everything hanging off it, whatever its status.
 * (The admin DELETE endpoint only accepts UPCOMING, so tests clean up
 * at the DB level instead.)
 */
async function purgeMatch(matchId) {
  await pool.query('DELETE FROM user_teams WHERE match_id = ?', [matchId]);
  await pool.query('DELETE FROM matches WHERE id = ?', [matchId]);
}

async function purgeUser(username) {
  const [[u]] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
  if (!u) return;
  await pool.query('DELETE FROM user_teams WHERE user_id = ?', [u.id]);
  await pool.query('DELETE FROM users WHERE id = ?', [u.id]);
}

const byRole = (players, role) =>
  players.filter((p) => p.role === role).sort((a, b) => Number(a.credit) - Number(b.credit));

/**
 * Cheapest squad that satisfies every rule:
 * 4 BAT + 1 WK + 2 AR + 4 BOWL = 11, comfortably inside the 100-credit budget.
 * `offset` shifts each role slice so different users get different squads.
 */
function cheapestValidSquad(players, offset = 0) {
  const take = (role, n) => byRole(players, role).slice(offset, offset + n);
  const squad = [...take('BATSMAN', 4), ...take('WICKET_KEEPER', 1), ...take('ALL_ROUNDER', 2), ...take('BOWLER', 4)];
  if (squad.length !== 11) {
    throw new Error(`cheapestValidSquad(offset=${offset}) produced ${squad.length} players — not enough seeded players`);
  }
  return squad;
}

/** Most expensive rule-valid squad — used to trip the budget check. */
function priciestSquad(players) {
  const take = (role, n) => byRole(players, role).reverse().slice(0, n);
  return [...take('BATSMAN', 4), ...take('WICKET_KEEPER', 1), ...take('ALL_ROUNDER', 2), ...take('BOWLER', 4)];
}

const creditsOf = (squad) => squad.reduce((s, p) => s + Number(p.credit), 0);
const idsOf = (squad) => squad.map((p) => p.id);

module.exports = {
  startApi, stopApi, api, login,
  createMatch, purgeMatch, purgeUser,
  byRole, cheapestValidSquad, priciestSquad, creditsOf, idsOf,
  pool,
};
