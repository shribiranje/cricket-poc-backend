/**
 * 3] Once a match is finished, the leaderboard must be correct.
 *
 * The engine is deliberately random, so these tests assert INVARIANTS rather
 * than magic numbers:
 *   - every entrant appears exactly once, ranked 1..N
 *   - entries are ordered by points, highest first
 *   - each total equals the sum of that user's player points with the
 *     captain (2x) and vice-captain (1.5x) multipliers applied
 *   - the match itself reports COMPLETED with a result string
 *   - picking a different captain from the same 11 changes the total
 *
 * Three users share one squad but nominate different captains, which isolates
 * the multiplier maths from squad-selection noise.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers'); // must be first: sets NODE_ENV=test before config loads
const config = require('../src/config');

const CAP = config.rules.captainMultiplier;        // 2
const VC = config.rules.viceCaptainMultiplier;     // 1.5

const USERS = ['demo', 'alice', 'bob'];

let tokens = {};
let matchId;
let squad;
let picks = {}; // username -> { captainId, viceCaptainId }
const created = [];

/** Recompute a user's expected total from their own team, the way the app should. */
function expectedTotal(teamPlayers) {
  const raw = teamPlayers.reduce((sum, p) => {
    const mult = p.isCaptain ? CAP : p.isViceCaptain ? VC : 1;
    return sum + Number(p.points) * mult;
  }, 0);
  return Math.round(raw * 100) / 100;
}

test.before(async () => {
  await h.startApi();
  for (const u of USERS) tokens[u] = await h.login(u);

  matchId = await h.createMatch(tokens.demo, {
    teamAId: 1, teamBId: 2,
    startTimeUtc: new Date(Date.now() + 3600_000).toISOString(),
    autoStart: false,
  });
  created.push(matchId);

  const players = (await h.api('GET', `/matches/${matchId}/players`, { token: tokens.demo })).data;
  squad = h.cheapestValidSquad(players);

  // Same 11 for everyone; different captain / vice-captain each.
  const combos = [[0, 1], [2, 3], [4, 5]];
  for (let i = 0; i < USERS.length; i++) {
    const u = USERS[i];
    const [c, v] = combos[i];
    picks[u] = { captainId: squad[c].id, viceCaptainId: squad[v].id };
    const r = await h.api('POST', `/matches/${matchId}/teams`, {
      token: tokens[u],
      body: { playerIds: h.idsOf(squad), ...picks[u] },
    });
    assert.ok([200, 201].includes(r.status), `${u} could not enter: ${JSON.stringify(r.raw)}`);
  }

  // Play the whole match instantly; END_MATCH auto-completes it.
  await h.api('POST', `/admin/matches/${matchId}/start`, { token: tokens.demo });
  const play = await h.api('POST', `/admin/matches/${matchId}/autoplay`, {
    token: tokens.demo,
    body: { mode: 'END_MATCH' },
  });
  assert.equal(play.status, 200, `autoplay failed: ${JSON.stringify(play.raw)}`);
  assert.equal(play.data.finished, true);
});

test.after(async () => {
  for (const id of created) await h.purgeMatch(id);
  await h.stopApi();
});

// ---------------------------------------------------------------- match end

test('the match is COMPLETED and carries a result once played out', async () => {
  const m = await h.api('GET', `/matches/${matchId}`, { token: tokens.demo });
  assert.equal(m.data.status, 'COMPLETED');

  const st = await h.api('GET', `/matches/${matchId}/state`, { token: tokens.demo });
  assert.equal(st.data.finished, true);
  assert.match(st.data.result, /won by|tied/i, `unexpected result string: ${st.data.result}`);
});

test('the engine actually scored some players', async () => {
  const [[row]] = await h.pool.query(
    'SELECT COALESCE(SUM(points),0) total, COUNT(*) n FROM player_match_stats WHERE match_id = ?',
    [matchId]
  );
  assert.ok(Number(row.n) > 0, 'stat rows must exist for the match');
  assert.ok(Number(row.total) !== 0, 'a completed match must have produced fantasy points');
});

// ---------------------------------------------------------------- leaderboard

test('every entrant appears exactly once with sequential ranks', async () => {
  const lb = (await h.api('GET', `/matches/${matchId}/leaderboard`, { token: tokens.demo })).data;

  assert.equal(lb.length, USERS.length);
  assert.deepEqual(lb.map((e) => e.rank), [1, 2, 3]);

  const names = lb.map((e) => e.username).sort();
  assert.deepEqual(names, [...USERS].sort(), 'all three entrants present, none duplicated');
});

test('the leaderboard is ordered by points, highest first', async () => {
  const lb = (await h.api('GET', `/matches/${matchId}/leaderboard`, { token: tokens.demo })).data;
  for (let i = 1; i < lb.length; i++) {
    assert.ok(lb[i - 1].totalPoints >= lb[i].totalPoints,
      `rank ${i} (${lb[i - 1].totalPoints}) must not score below rank ${i + 1} (${lb[i].totalPoints})`);
  }
});

test('each total equals that user\'s player points with C/VC multipliers applied', async () => {
  const lb = (await h.api('GET', `/matches/${matchId}/leaderboard`, { token: tokens.demo })).data;

  for (const u of USERS) {
    const mine = (await h.api('GET', `/matches/${matchId}/teams/me`, { token: tokens[u] })).data;
    const entry = lb.find((e) => e.username === u);

    assert.equal(mine.players.length, 11);
    assert.equal(mine.players.filter((p) => p.isCaptain).length, 1);
    assert.equal(mine.players.filter((p) => p.isViceCaptain).length, 1);

    const expected = expectedTotal(mine.players);
    assert.ok(Math.abs(entry.totalPoints - expected) < 0.011,
      `${u}: leaderboard says ${entry.totalPoints}, recomputed ${expected}`);
    assert.equal(entry.totalPoints, mine.totalPoints, `${u}: /teams/me and leaderboard must agree`);
  }
});

test('the captain multiplier genuinely changes the total', async () => {
  // Everyone picked the SAME 11 players, so any difference in totals can only
  // come from the captain / vice-captain multipliers.
  const lb = (await h.api('GET', `/matches/${matchId}/leaderboard`, { token: tokens.demo })).data;
  const totals = lb.map((e) => e.totalPoints);

  const mine = (await h.api('GET', `/matches/${matchId}/teams/me`, { token: tokens.demo })).data;
  const capPoints = mine.players.filter((p) => p.isCaptain || p.isViceCaptain)
    .reduce((s, p) => s + Number(p.points), 0);

  if (capPoints !== 0) {
    assert.ok(new Set(totals).size > 1,
      'different captains scoring points must produce different totals');
  }

  // A captain is worth exactly 2x their raw points inside the total.
  const base = mine.players.reduce((s, p) => s + Number(p.points), 0);
  const cap = mine.players.find((p) => p.isCaptain);
  const vc = mine.players.find((p) => p.isViceCaptain);
  const expected = Math.round((base + Number(cap.points) * (CAP - 1) + Number(vc.points) * (VC - 1)) * 100) / 100;
  assert.ok(Math.abs(mine.totalPoints - expected) < 0.011,
    `total ${mine.totalPoints} should equal base ${base} plus captain/VC bonuses (${expected})`);
});

test('credits used are reported alongside points', async () => {
  const lb = (await h.api('GET', `/matches/${matchId}/leaderboard`, { token: tokens.demo })).data;
  const cost = h.creditsOf(squad);
  for (const e of lb) {
    assert.equal(e.totalCreditsUsed, cost);
    assert.ok(e.totalCreditsUsed <= config.rules.creditBudget);
  }
});

test('a match with no entrants returns an empty leaderboard, not an error', async () => {
  const empty = await h.createMatch(tokens.demo, { teamAId: 3, teamBId: 4, autoStart: false });
  created.push(empty);

  const r = await h.api('GET', `/matches/${empty}/leaderboard`, { token: tokens.demo });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, []);
});
