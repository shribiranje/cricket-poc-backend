/**
 * Sportmonks Sync CLI
 * -------------------
 * Pulls fixtures + lineups from Sportmonks and populates the local DB
 * (teams, players, matches, match_players).
 *
 * Efficient: uses the /fixtures list endpoint with `include=lineup,localteam,
 * visitorteam,venue` so we do ONE paginated call, not N+1. Also throttles
 * between pages and retries on rate limits.
 *
 * Usage:
 *   npm run sportmonks:sync                             # next 7 days from all subscribed leagues
 *   npm run sportmonks:sync -- --days 3
 *   npm run sportmonks:sync -- --league 1
 *   npm run sportmonks:sync -- --fixture 59282
 *   npm run sportmonks:sync -- --limit 5                # cap number of fixtures
 *   npm run sportmonks:sync -- --page-delay 2000        # ms between paginated calls
 *
 * Idempotent: uses external_id UNIQUE constraints so re-running just updates.
 */
const pool = require('../config/db');
const config = require('../config');
const { smFetch, sleep } = require('../services/sportmonks.service');

const INCLUDES = 'lineup,localteam,visitorteam,venue';

// ---------- Args ----------
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k === '--days')            out.days = Number(args[++i]);
    else if (k === '--league')     out.league = args[++i];
    else if (k === '--fixture')    out.fixture = args[++i];
    else if (k === '--limit')      out.limit = Number(args[++i]);
    else if (k === '--page-delay') out.pageDelay = Number(args[++i]);
    else if (k === '--include-past') out.includePastDays = Number(args[++i]);
    else if (k === '--team')       out.team = args[++i];
    else if (k === '--help')       { help(); process.exit(0); }
  }
  return out;
}

function help() {
  console.log(`Usage:
  npm run sportmonks:sync                          Sync UPCOMING fixtures for next SPORTMONKS_SYNC_DAYS days (default 7)
  npm run sportmonks:sync -- --days 3              Override lookahead window
  npm run sportmonks:sync -- --league 1            Only sync a specific Sportmonks league_id
  npm run sportmonks:sync -- --fixture 59282       Sync one specific fixture by id
  npm run sportmonks:sync -- --limit 5             Stop after N fixtures (great for demos)
  npm run sportmonks:sync -- --team "India"        Only keep fixtures where a team name contains "India"
  npm run sportmonks:sync -- --include-past 2      Also include matches from the last N days (for history demo)
  npm run sportmonks:sync -- --page-delay 2000     ms between paginated list calls (default 1500)`);
}

// ---------- Role & credit mapping ----------
function mapRole(positionName) {
  const p = String(positionName || '').toLowerCase();
  if (p.includes('wicket')) return 'WICKET_KEEPER';
  if (p.includes('all'))    return 'ALL_ROUNDER';
  if (p.includes('bowl'))   return 'BOWLER';
  if (p.includes('bat'))    return 'BATSMAN';
  return 'BATSMAN';
}

function creditForRole(role) {
  return {
    BATSMAN: 9.0, WICKET_KEEPER: 8.5, ALL_ROUNDER: 9.5, BOWLER: 8.5,
  }[role] || 8.0;
}

function mapFormat(t) {
  if (!t) return 'T20';
  const s = String(t);
  if (/T20I?/i.test(s)) return 'T20';
  if (/ODI/i.test(s))   return 'ODI';
  if (/Test|5day/i.test(s)) return 'Test';
  return s.slice(0, 20);
}

// ---------- Upserts ----------
async function upsertTeam(sm) {
  if (!sm?.id) return null;
  const shortName = (sm.code || sm.name || '').slice(0, 10).toUpperCase();
  const [res] = await pool.query(
    `INSERT INTO teams (external_id, name, short_name, logo_url)
       VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), short_name = VALUES(short_name), logo_url = VALUES(logo_url),
       id = LAST_INSERT_ID(id)`,
    [sm.id, sm.name || 'Unknown', shortName, sm.image_path || null]
  );
  return res.insertId;
}

async function upsertPlayer(sm, teamId) {
  if (!sm?.id || !teamId) return null;
  const role = mapRole(sm?.position?.name);
  const credit = creditForRole(role);
  const [res] = await pool.query(
    `INSERT INTO players (external_id, team_id, name, role, credit)
       VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       team_id = VALUES(team_id), name = VALUES(name), role = VALUES(role),
       id = LAST_INSERT_ID(id)`,
    [sm.id, teamId, sm.fullname || sm.firstname || 'Unknown', role, credit]
  );
  return res.insertId;
}

async function upsertFixture(fixture) {
  if (!fixture?.id) return null;

  const teamA = await upsertTeam(fixture.localteam);
  const teamB = await upsertTeam(fixture.visitorteam);
  if (!teamA || !teamB) {
    console.warn(`  ↳ skipping fixture ${fixture.id}: missing team info`);
    return null;
  }

  let status = 'UPCOMING';
  const raw = String(fixture.status || '');
  if (/Finished|Aban|Postp|Cancl|Awarded/i.test(raw)) status = 'COMPLETED';
  else if (fixture.live || (raw && raw !== 'NS')) status = 'LIVE';

  const [res] = await pool.query(
    `INSERT INTO matches
       (external_id, team_a_id, team_b_id, format, venue, start_time, status, external_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       team_a_id = VALUES(team_a_id), team_b_id = VALUES(team_b_id),
       format = VALUES(format), venue = VALUES(venue),
       start_time = VALUES(start_time), status = VALUES(status),
       external_status = VALUES(external_status),
       id = LAST_INSERT_ID(id)`,
    [
      fixture.id, teamA, teamB,
      mapFormat(fixture.type),
      fixture.venue?.name || null,
      new Date(fixture.starting_at),
      status,
      fixture.status || null,
    ]
  );
  const matchId = res.insertId;

  const lineup = fixture.lineup || [];
  if (!lineup.length) {
    // Not an error — Sportmonks releases lineups closer to start time
    return { matchId, hadLineup: false };
  }

  for (const p of lineup) {
    const smTeamId = p.lineup?.team_id ?? p.team_id;
    let internalTeamId = null;
    if (smTeamId === fixture.localteam?.id) internalTeamId = teamA;
    else if (smTeamId === fixture.visitorteam?.id) internalTeamId = teamB;
    if (!internalTeamId) continue;

    const playerId = await upsertPlayer(p, internalTeamId);
    if (!playerId) continue;

    await pool.query(
      `INSERT IGNORE INTO match_players (match_id, player_id) VALUES (?, ?)`,
      [matchId, playerId]
    );
  }

  return { matchId, hadLineup: true };
}

// ---------- Discovery ----------
async function fetchFixtureList({ days, leagueIds, limit, pageDelay, includePastDays }) {
  const now = new Date();
  const pastDays = Math.max(0, Number(includePastDays) || 0);
  const from = new Date(now.getTime() - pastDays * 86400_000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + days * 86400_000).toISOString().slice(0, 10);

  const baseQ = {
    filter: `starts_between:${from},${to}`,
    sort: 'starting_at',
    include: INCLUDES,
  };
  if (leagueIds && leagueIds.length) baseQ.leagues = leagueIds.join(',');

  const all = [];
  let page = 1;
  const maxPages = 20;
  while (page <= maxPages) {
    console.log(`  Fetching page ${page}…`);
    const res = await smFetch('/fixtures', { ...baseQ, page });
    const rows = res.data || [];
    all.push(...rows);
    if (limit && all.length >= limit) {
      all.length = limit;
      break;
    }
    if (rows.length < 25) break; // last page
    page++;
    if (pageDelay > 0) {
      console.log(`  Throttling ${pageDelay}ms before next page…`);
      await sleep(pageDelay);
    }
  }
  console.log(`  Discovered ${all.length} fixtures between ${from} and ${to}\n`);
  return all;
}

// ---------- Main ----------
async function main() {
  if (!config.sportmonks.apiToken) {
    console.error('SPORTMONKS_API_TOKEN not set. Edit backend/.env');
    process.exit(1);
  }

  const args = parseArgs();
  const pageDelay = args.pageDelay ?? 1500;

  let fixtures;
  if (args.fixture) {
    // Single-fixture path — still uses one call
    const res = await smFetch(`/fixtures/${args.fixture}`, { include: INCLUDES });
    fixtures = res.data ? [res.data] : [];
  } else {
    const days = args.days || config.sportmonks.syncDays;
    const leagueIds = args.league ? [String(args.league)] : config.sportmonks.leagueIds;
    fixtures = await fetchFixtureList({
      days, leagueIds, limit: args.limit, pageDelay,
      includePastDays: args.includePastDays || 0,
    });
  }

  // Optional team-name filter (post-fetch, case-insensitive substring match on either team)
  if (args.team) {
    const needle = String(args.team).toLowerCase();
    const before = fixtures.length;
    fixtures = fixtures.filter((f) => {
      const a = String(f.localteam?.name || '').toLowerCase();
      const b = String(f.visitorteam?.name || '').toLowerCase();
      return a.includes(needle) || b.includes(needle);
    });
    console.log(`Team filter "${args.team}": ${before} → ${fixtures.length} fixtures\n`);
  }

  if (!fixtures.length) {
    console.log('No fixtures to sync.');
    process.exit(0);
  }

  let ok = 0, fail = 0, noLineup = 0;
  for (const f of fixtures) {
    try {
      const result = await upsertFixture(f);
      if (result) {
        const tag = result.hadLineup ? '' : ' (lineup pending)';
        console.log(`✓ synced fixture ${f.id} → local match id ${result.matchId}${tag}`);
        if (!result.hadLineup) noLineup++;
        ok++;
      }
    } catch (e) {
      console.error(`✗ fixture ${f.id}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} succeeded (${noLineup} lineup pending), ${fail} failed.`);
  if (noLineup > 0) {
    console.log(`Note: lineups appear closer to match start. Re-run sync later to fetch them.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Sync failed:', e.message || e);
  process.exit(1);
});
