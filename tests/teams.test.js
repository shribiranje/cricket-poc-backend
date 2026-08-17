/**
 * 2] Users must be able to create teams properly — and be stopped from
 *    creating invalid ones.
 *
 * Rules under test (backend/src/config → rules):
 *   exactly 11 players, <= 100 credits, >=3 BAT, >=3 BOWL, >=1 AR, >=1 WK,
 *   <= 8 per role, no duplicates, captain != vice-captain, both in the squad,
 *   players must belong to the match, and entry closes once the match starts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');

let token;
let matchId;
let players;
const created = [];

test.before(async () => {
  await h.startApi();
  token = await h.login();
  matchId = await h.createMatch(token, { teamAId: 1, teamBId: 2 }); // MI vs CSK
  created.push(matchId);
  players = (await h.api('GET', `/matches/${matchId}/players`, { token })).data;
});

test.after(async () => {
  for (const id of created) await h.purgeMatch(id);
  await h.stopApi();
});

const submit = (squad, capIdx = 0, vcIdx = 1, tk = token, id = matchId) =>
  h.api('POST', `/matches/${id}/teams`, {
    token: tk,
    body: { playerIds: h.idsOf(squad), captainId: squad[capIdx].id, viceCaptainId: squad[vcIdx].id },
  });

// ---------------------------------------------------------------- happy path

test('the match exposes both full squads to pick from', () => {
  assert.equal(players.length, 30, 'two 15-man squads');
  for (const p of players) {
    assert.ok(['BATSMAN', 'BOWLER', 'ALL_ROUNDER', 'WICKET_KEEPER'].includes(p.role));
    assert.ok(Number(p.credit) > 0);
  }
});

test('a valid 11-player team is accepted and persisted', async () => {
  const squad = h.cheapestValidSquad(players);
  assert.equal(squad.length, 11);
  assert.ok(h.creditsOf(squad) <= 100, 'fixture must be inside the budget');

  const r = await submit(squad);
  assert.equal(r.status, 201);
  assert.ok(r.data.userTeamId > 0);
  assert.equal(r.data.totalCreditsUsed, h.creditsOf(squad), 'credits are computed server-side');

  const mine = await h.api('GET', `/matches/${matchId}/teams/me`, { token });
  assert.equal(mine.data.players.length, 11);
  assert.equal(mine.data.isLocked, false, 'editable while the match is upcoming');
  assert.equal(mine.data.players.filter((p) => p.isCaptain).length, 1);
  assert.equal(mine.data.players.filter((p) => p.isViceCaptain).length, 1);
});

test('re-submitting replaces the squad instead of creating a second entry', async () => {
  const first = await submit(h.cheapestValidSquad(players, 0));
  const second = await submit(h.cheapestValidSquad(players, 1));

  assert.equal(second.status, 200, 'an update, not a create');
  assert.equal(second.data.userTeamId, first.data.userTeamId, 'same user_team row');

  const mine = await h.api('GET', `/matches/${matchId}/teams/me`, { token });
  assert.equal(mine.data.players.length, 11, 'no duplicate players left behind');
});

test('a user only ever has one team per match', async () => {
  const [rows] = await h.pool.query(
    'SELECT COUNT(*) c FROM user_teams WHERE match_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)',
    [matchId, 'demo']
  );
  assert.equal(Number(rows[0].c), 1);
});

// ---------------------------------------------------------------- rejections

test('a squad that is not exactly 11 players is rejected', async () => {
  const squad = h.cheapestValidSquad(players).slice(0, 10);
  const r = await submit(squad);
  assert.equal(r.status, 400);
  // Two layers guard this: the route validator (isArray min/max 11) fires first
  // and returns VALIDATION_ERROR; validateComposition() would return
  // INVALID_TEAM_SIZE if a payload ever reached it. Either is a correct reject.
  assert.ok(['VALIDATION_ERROR', 'INVALID_TEAM_SIZE'].includes(r.error.code), r.error.code);
});

test('duplicate players are rejected', async () => {
  const squad = h.cheapestValidSquad(players);
  const dupes = [...squad.slice(0, 10), squad[0]]; // 11 entries, one repeated
  const r = await h.api('POST', `/matches/${matchId}/teams`, {
    token,
    body: { playerIds: h.idsOf(dupes), captainId: squad[0].id, viceCaptainId: squad[1].id },
  });
  assert.equal(r.status, 400);
  assert.ok(['DUPLICATE_PLAYERS', 'INVALID_PLAYERS'].includes(r.error.code), r.error.code);
});

test('going over the credit budget is rejected', async () => {
  const squad = h.priciestSquad(players);
  assert.equal(squad.length, 11);
  assert.ok(h.creditsOf(squad) > 100,
    `fixture assumption broken: priciest XI costs ${h.creditsOf(squad)}, expected > 100`);

  const r = await submit(squad);
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'BUDGET_EXCEEDED');
});

test('a squad without the minimum bowlers is rejected', async () => {
  const noBowlers = [
    ...h.byRole(players, 'BATSMAN').slice(0, 8),
    ...h.byRole(players, 'WICKET_KEEPER').slice(0, 1),
    ...h.byRole(players, 'ALL_ROUNDER').slice(0, 2),
  ];
  assert.equal(noBowlers.length, 11);
  assert.ok(h.creditsOf(noBowlers) <= 100, 'must fail on roles, not budget');

  const r = await submit(noBowlers);
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'MIN_BOWLERS');
});

test('a captain outside the squad is rejected', async () => {
  const squad = h.cheapestValidSquad(players);
  const outsider = players.find((p) => !h.idsOf(squad).includes(p.id));
  const r = await h.api('POST', `/matches/${matchId}/teams`, {
    token,
    body: { playerIds: h.idsOf(squad), captainId: outsider.id, viceCaptainId: squad[1].id },
  });
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'INVALID_CAPTAIN');
});

test('captain and vice-captain must be different players', async () => {
  const squad = h.cheapestValidSquad(players);
  const r = await submit(squad, 0, 0);
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'CAPTAIN_VC_SAME');
});

test('players from another match are rejected', async () => {
  const other = await h.createMatch(token, { teamAId: 5, teamBId: 6 }); // DC vs SRH
  created.push(other);
  const otherPlayers = (await h.api('GET', `/matches/${other}/players`, { token })).data;

  const squad = h.cheapestValidSquad(players);
  const mixed = [...squad.slice(0, 10), otherPlayers[0]];
  const r = await h.api('POST', `/matches/${matchId}/teams`, {
    token,
    body: { playerIds: h.idsOf(mixed), captainId: squad[0].id, viceCaptainId: squad[1].id },
  });
  assert.equal(r.status, 400);
  assert.equal(r.error.code, 'INVALID_PLAYERS');
});

test('anonymous users cannot create a team', async () => {
  const squad = h.cheapestValidSquad(players);
  const r = await h.api('POST', `/matches/${matchId}/teams`, {
    body: { playerIds: h.idsOf(squad), captainId: squad[0].id, viceCaptainId: squad[1].id },
  });
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------- lock

test('entry closes once the match is live', async () => {
  const live = await h.createMatch(token, {
    teamAId: 1, teamBId: 2,
    startTimeUtc: new Date(Date.now() - 60_000).toISOString(),
    autoStart: false,
  });
  created.push(live);

  const livePlayers = (await h.api('GET', `/matches/${live}/players`, { token })).data;
  const squad = h.cheapestValidSquad(livePlayers);

  await h.api('POST', `/admin/matches/${live}/start`, { token });

  const r = await submit(squad, 0, 1, token, live);
  assert.equal(r.status, 400);
  assert.ok(['MATCH_LOCKED', 'TEAM_LOCKED'].includes(r.error.code), r.error.code);
});
