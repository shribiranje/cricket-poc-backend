/**
 * 1] A match must start at the right moment for its timezone.
 *
 * The contract under test:
 *   - matches.start_time is stored in UTC; matches.timezone is a DISPLAY label
 *     and must never shift the instant.
 *   - The API always emits ISO-8601 with a 'Z' suffix.
 *   - The scheduler flips UPCOMING → LIVE only when the UTC instant has passed,
 *     only for auto_start=1, and never for external (Sportmonks) fixtures.
 *
 * Regression guarded: a match scheduled for 19:30 Asia/Kolkata must go live at
 * 14:00Z — NOT at 19:30Z (5h30m late).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers'); // must be first: sets NODE_ENV=test before config loads
const { toMysqlUtc, toIsoUtc } = require('../src/utils/datetime');
const scheduler = require('../src/services/scheduler.service');

let token;
const created = [];

test.before(async () => {
  await h.startApi();
  token = await h.login();
});

test.after(async () => {
  for (const id of created) await h.purgeMatch(id);
  await h.stopApi();
});

// ---------------------------------------------------------------- conversion

test('toMysqlUtc converts an offset-qualified time to the correct UTC instant', () => {
  // 19:30 in Asia/Kolkata (+05:30) is 14:00 UTC
  assert.equal(toMysqlUtc('2026-07-15T19:30:00+05:30'), '2026-07-15 14:00:00');
  // 19:30 in New York summer (EDT, -04:00) is 23:30 UTC
  assert.equal(toMysqlUtc('2026-07-15T19:30:00-04:00'), '2026-07-15 23:30:00');
  // 19:30 in New York winter (EST, -05:00) rolls over midnight
  assert.equal(toMysqlUtc('2026-12-15T19:30:00-05:00'), '2026-12-16 00:30:00');
  // Already UTC passes through
  assert.equal(toMysqlUtc('2026-07-15T14:00:00Z'), '2026-07-15 14:00:00');
});

test('toMysqlUtc does NOT treat 19:30 IST as 19:30 UTC (the 5h30m bug)', () => {
  const stored = toMysqlUtc('2026-07-15T19:30:00+05:30');
  assert.equal(stored, '2026-07-15 14:00:00');
  assert.notEqual(stored, '2026-07-15 19:30:00');
});

test('toIsoUtc always emits a Z-qualified ISO string the browser can parse', () => {
  assert.equal(toIsoUtc('2026-07-15 14:00:00'), '2026-07-15T14:00:00.000Z');
  assert.equal(new Date(toIsoUtc('2026-07-15 14:00:00')).toISOString(), '2026-07-15T14:00:00.000Z');
  assert.equal(toIsoUtc(null), null);
});

test('toMysqlUtc / toIsoUtc round-trip without drift', () => {
  const iso = '2026-07-15T14:00:00.000Z';
  assert.equal(toIsoUtc(toMysqlUtc(iso)), iso);
});

// ---------------------------------------------------------------- storage

test('a match keeps its exact UTC instant and timezone label through the API', async () => {
  const startTimeUtc = '2026-07-15T14:00:00.000Z'; // 19:30 IST
  const id = await h.createMatch(token, { startTimeUtc, timezone: 'Asia/Kolkata' });
  created.push(id);

  const r = await h.api('GET', `/matches/${id}`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.startTime, startTimeUtc, 'instant must survive the round trip');
  assert.equal(r.data.timezone, 'Asia/Kolkata', 'label is stored for display');
});

test('the timezone label is cosmetic — identical instants store identically', async () => {
  // 19:30 IST and 10:00 EDT are the SAME moment (14:00Z)
  const ist = await h.createMatch(token, {
    startTimeUtc: new Date('2026-07-15T19:30:00+05:30').toISOString(), timezone: 'Asia/Kolkata',
  });
  const edt = await h.createMatch(token, {
    startTimeUtc: new Date('2026-07-15T10:00:00-04:00').toISOString(), timezone: 'America/New_York',
  });
  created.push(ist, edt);

  const a = await h.api('GET', `/matches/${ist}`, { token });
  const b = await h.api('GET', `/matches/${edt}`, { token });

  assert.equal(a.data.startTime, b.data.startTime, 'same instant regardless of zone label');
  assert.equal(a.data.startTime, '2026-07-15T14:00:00.000Z');
  assert.notEqual(a.data.timezone, b.data.timezone, 'but the display labels differ');
});

test('an invalid start time is rejected', async () => {
  const r = await h.api('POST', '/admin/matches', {
    token,
    body: { teamAId: 1, teamBId: 2, startTimeUtc: 'not-a-date', timezone: 'UTC' },
  });
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------- scheduler

test('scheduler starts a match once its UTC instant has passed', async () => {
  const id = await h.createMatch(token, {
    startTimeUtc: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    autoStart: true,
  });
  created.push(id);

  let before = await h.api('GET', `/matches/${id}`, { token });
  assert.equal(before.data.status, 'UPCOMING');

  await scheduler.tickOnce(); // deterministic — no waiting on the interval

  const after = await h.api('GET', `/matches/${id}`, { token });
  assert.equal(after.data.status, 'LIVE', 'due match must go live');
});

test('scheduler does NOT start a match before its time', async () => {
  const id = await h.createMatch(token, {
    startTimeUtc: new Date(Date.now() + 3600_000).toISOString(), // 1h away
    autoStart: true,
  });
  created.push(id);

  await scheduler.tickOnce();

  const r = await h.api('GET', `/matches/${id}`, { token });
  assert.equal(r.data.status, 'UPCOMING', 'future match must stay upcoming');
});

test('a 19:30 IST match is not started early by a UTC-naive comparison', async () => {
  // "19:30 today in Kolkata" — still in the future as a UTC instant (14:00Z),
  // but a naive implementation reading it as 19:30Z would ALSO be future, so we
  // pick a window where the two readings disagree: 3 hours ago in IST wall time
  // is 3h ago UTC too, but a +5:30 mis-parse would place it 5.5h EARLIER.
  // Concretely: a match 1 hour in the future must never start now.
  const inOneHour = new Date(Date.now() + 3600_000);
  const id = await h.createMatch(token, {
    startTimeUtc: inOneHour.toISOString(),
    timezone: 'Asia/Kolkata',
    autoStart: true,
  });
  created.push(id);

  await scheduler.tickOnce();
  const r = await h.api('GET', `/matches/${id}`, { token });
  assert.equal(r.data.status, 'UPCOMING',
    'an IST-labelled match must be compared as UTC, not shifted by the label');
});

test('scheduler skips matches with auto_start disabled', async () => {
  const id = await h.createMatch(token, {
    startTimeUtc: new Date(Date.now() - 60_000).toISOString(),
    autoStart: false,
  });
  created.push(id);

  await scheduler.tickOnce();

  const r = await h.api('GET', `/matches/${id}`, { token });
  assert.equal(r.data.status, 'UPCOMING', 'manual-start matches must be left alone');
});

test('scheduler skips external (Sportmonks) fixtures', async () => {
  const id = await h.createMatch(token, {
    startTimeUtc: new Date(Date.now() - 60_000).toISOString(),
    autoStart: true,
  });
  created.push(id);
  await h.pool.query('UPDATE matches SET external_id = ? WHERE id = ?', [999_001, id]);

  await scheduler.tickOnce();

  const [[row]] = await h.pool.query('SELECT status FROM matches WHERE id = ?', [id]);
  assert.equal(row.status, 'UPCOMING', 'the live feed owns external fixtures, not the scheduler');
});

test('starting a match locks every team entered for it', async () => {
  const id = await h.createMatch(token, {
    startTimeUtc: new Date(Date.now() - 60_000).toISOString(),
    autoStart: true,
  });
  created.push(id);

  const players = (await h.api('GET', `/matches/${id}/players`, { token })).data;
  const squad = h.cheapestValidSquad(players);
  await h.api('POST', `/matches/${id}/teams`, {
    token,
    body: { playerIds: h.idsOf(squad), captainId: squad[0].id, viceCaptainId: squad[1].id },
  });

  await scheduler.tickOnce();

  const mine = await h.api('GET', `/matches/${id}/teams/me`, { token });
  assert.equal(mine.data.isLocked, true, 'auto-start must lock entries');
});
