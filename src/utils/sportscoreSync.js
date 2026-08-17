/**
 * SportScore Sync CLI
 * -------------------
 * Pulls cricket matches (live + recent + upcoming from /api/widget/matches/)
 * and per-match lineups (/api/widget/match/) into the local DB
 * (teams, players, matches, match_players) keyed by external_slug.
 *
 * Usage:
 *   npm run sportscore:sync                     # discover matches, sync all with lineups
 *   npm run sportscore:sync -- --limit 3        # cap number of matches (saves quota)
 *   npm run sportscore:sync -- --team "India"   # filter by team-name substring
 *   npm run sportscore:sync -- --slug a-vs-b    # sync one specific match slug
 *
 * QUOTA NOTE: each synced match = 1 detail request. The free tier is
 * ~1000 req/24h shared with the live poller, so use --limit generously.
 *
 * FIELD NAMES marked ADJUST are best-guess — run `npm run sportscore:probe`
 * first and fix them against the real payloads in probe-output/.
 */
const pool = require('../config/db');
const config = require('../config');
const { ssFetch, mapStatus } = require('../services/sportscore.service');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') out.limit = Number(args[++i]);
    else if (args[i] === '--team') out.team = args[++i];
    else if (args[i] === '--slug') out.slug = args[++i];
  }
  return out;
}

/* ---------- Role & credit mapping (same policy as sportmonksSync) ---------- */
function mapRole(positionName) {
  const p = String(positionName || '').toLowerCase();
  if (p.includes('wicket') || p.includes('keeper') || p === 'wk') return 'WICKET_KEEPER';
  if (p.includes('all')) return 'ALL_ROUNDER';
  if (p.includes('bowl')) return 'BOWLER';
  if (p.includes('bat')) return 'BATSMAN';
  return 'BATSMAN';
}
function creditForRole(role) {
  return { BATSMAN: 9.0, WICKET_KEEPER: 8.5, ALL_ROUNDER: 9.5, BOWLER: 8.5 }[role] || 8.0;
}
function mapFormat(t) {
  const s = String(t || '');
  if (/T20I?|twenty/i.test(s)) return 'T20';
  if (/ODI|one.?day|50/i.test(s)) return 'ODI';
  if (/Test/i.test(s)) return 'Test';
  return 'T20';
}

/* ---------- ADJUST: payload extraction ---------- */
function extractMatchList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const k of ['matches', 'results', 'data', 'items', 'events']) {
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  return [];
}
function matchSlug(m) {
  const direct = m?.slug || m?.match_slug || m?.url_slug || m?.id_slug;
  if (direct) return String(direct);
  // Widget APIs often expose the slug only inside a URL/permalink field,
  // e.g. "/cricket/match/india-vs-australia-2026-07-21/".
  for (const k of ['url', 'link', 'href', 'match_url', 'permalink', 'web_url']) {
    const v = m?.[k];
    if (typeof v !== 'string') continue;
    const byPath = v.match(/\/match\/([^\/?#]+)/i);
    if (byPath) return byPath[1];
    const trailing = v.replace(/\/+$/, '').split('/').pop();
    if (trailing && /-vs-/i.test(trailing)) return trailing;
  }
  return null;
}
/** Print the shape of an unrecognized match object once, so the real slug
 *  field name is visible in the console instead of a silent null. */
let dumpedUnknownShape = false;
function reportMissingSlug(m) {
  if (dumpedUnknownShape) return;
  dumpedUnknownShape = true;
  console.warn(
    '  ↳ could not find a slug on this match object. Top-level keys were:\n' +
    `    [${Object.keys(m || {}).join(', ')}]\n` +
    '    Run `npm run sportscore:probe`, open probe-output/sportscore-matches.json,\n' +
    '    and update matchSlug() in src/utils/sportscoreSync.js with the real field.'
  );
}
function homeTeam(m)  { return m?.home_team || m?.home || m?.localteam || m?.teams?.[0] || null; }
function awayTeam(m)  { return m?.away_team || m?.away || m?.visitorteam || m?.teams?.[1] || null; }
function teamSlug(t)  { return t?.slug || t?.team_slug || null; }
function teamName(t)  { return t?.name || t?.team_name || null; }
function startTime(m) {
  const v = m?.start_time || m?.starting_at || m?.kickoff || m?.datetime || m?.date;
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? d : null;
}
/** Lineups from match detail — try plausible shapes. */
function extractLineups(detail) {
  // shape A: detail.lineups = { home: [...], away: [...] }
  if (detail?.lineups && !Array.isArray(detail.lineups)) {
    return {
      home: detail.lineups.home || detail.lineups.localteam || [],
      away: detail.lineups.away || detail.lineups.visitorteam || [],
    };
  }
  // shape B: detail.lineups = [{ team_slug, players: [...] }, ...]
  if (Array.isArray(detail?.lineups)) {
    return { flat: detail.lineups };
  }
  return { home: [], away: [] };
}
function playerSlugOf(p) { return p?.slug || p?.player_slug || null; }
function playerNameOf(p) { return p?.name || p?.player_name || p?.fullname || 'Unknown'; }
function playerRoleOf(p) { return p?.role || p?.position || p?.position_name || null; }

/* ---------- Upserts ---------- */
async function upsertTeam(t) {
  const slug = teamSlug(t);
  const name = teamName(t);
  if (!slug && !name) return null;
  const shortName = (t?.code || t?.short_name || name || '').slice(0, 10).toUpperCase();
  const [res] = await pool.query(
    `INSERT INTO teams (external_slug, name, short_name, logo_url)
       VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), short_name = VALUES(short_name), logo_url = VALUES(logo_url),
       id = LAST_INSERT_ID(id)`,
    [slug || `name:${name}`, name || 'Unknown', shortName, t?.logo || t?.logo_url || t?.image || null]
  );
  return res.insertId;
}

async function upsertPlayer(p, teamId) {
  const slug = playerSlugOf(p);
  const name = playerNameOf(p);
  if (!teamId || (!slug && !name)) return null;
  const role = mapRole(playerRoleOf(p));
  const [res] = await pool.query(
    `INSERT INTO players (external_slug, team_id, name, role, credit)
       VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       team_id = VALUES(team_id), name = VALUES(name), role = VALUES(role),
       id = LAST_INSERT_ID(id)`,
    [slug || `name:${name}`, teamId, name, role, creditForRole(role)]
  );
  return res.insertId;
}

async function upsertMatch(summary, detail) {
  const slug = matchSlug(summary) || matchSlug(detail);
  if (!slug) { console.warn('  ↳ skipping match with no slug'); return null; }

  const home = homeTeam(detail) || homeTeam(summary);
  const away = awayTeam(detail) || awayTeam(summary);
  const teamA = await upsertTeam(home);
  const teamB = await upsertTeam(away);
  if (!teamA || !teamB) { console.warn(`  ↳ skipping ${slug}: missing team info`); return null; }

  const rawStatus = detail?.status || summary?.status || '';
  const start = startTime(detail) || startTime(summary) || new Date();

  const [res] = await pool.query(
    `INSERT INTO matches
       (external_slug, team_a_id, team_b_id, format, venue, start_time, status, external_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       team_a_id = VALUES(team_a_id), team_b_id = VALUES(team_b_id),
       format = VALUES(format), venue = VALUES(venue),
       start_time = VALUES(start_time), status = VALUES(status),
       external_status = VALUES(external_status),
       id = LAST_INSERT_ID(id)`,
    [
      slug, teamA, teamB,
      mapFormat(detail?.format || detail?.type || summary?.format),
      detail?.venue?.name || detail?.venue || null,
      start,
      mapStatus(rawStatus),
      String(rawStatus) || null,
    ]
  );
  const matchId = res.insertId;

  // Lineups
  const lu = extractLineups(detail);
  let count = 0;
  const attach = async (players, teamId) => {
    for (const p of players || []) {
      const pid = await upsertPlayer(p, teamId);
      if (!pid) continue;
      await pool.query(`INSERT IGNORE INTO match_players (match_id, player_id) VALUES (?, ?)`, [matchId, pid]);
      count++;
    }
  };
  if (lu.flat) {
    // Match team blocks to home/away by slug or name
    const hs = teamSlug(home), as = teamSlug(away);
    for (const block of lu.flat) {
      const bSlug = block.team_slug || block.slug || teamSlug(block.team);
      const teamId = bSlug === hs ? teamA : bSlug === as ? teamB : null;
      if (teamId) await attach(block.players || block.lineup, teamId);
    }
  } else {
    await attach(lu.home, teamA);
    await attach(lu.away, teamB);
  }

  return { matchId, playerCount: count };
}

/* ---------- Main ---------- */
async function main() {
  const args = parseArgs();

  let summaries;
  if (args.slug) {
    summaries = [{ slug: args.slug }];
  } else {
    console.log('Discovering cricket matches…');
    const payload = await ssFetch('/api/widget/matches/', { sport: 'cricket', limit: 50 });
    summaries = extractMatchList(payload);
    console.log(`  found ${summaries.length} matches\n`);
  }

  if (args.team) {
    const needle = args.team.toLowerCase();
    summaries = summaries.filter((m) => {
      const a = String(teamName(homeTeam(m)) || '').toLowerCase();
      const b = String(teamName(awayTeam(m)) || '').toLowerCase();
      return a.includes(needle) || b.includes(needle);
    });
    console.log(`Team filter "${args.team}": ${summaries.length} matches remain\n`);
  }
  if (args.limit) summaries = summaries.slice(0, args.limit);

  if (!summaries.length) { console.log('No matches to sync.'); process.exit(0); }

  let ok = 0, fail = 0, noLineup = 0, skipped = 0;
  for (const s of summaries) {
    const slug = matchSlug(s);
    if (!slug) {
      reportMissingSlug(s);
      skipped++;
      continue; // don't burn quota on a guaranteed 400
    }
    try {
      const detail = await ssFetch('/api/widget/match/', { sport: 'cricket', slug });
      const result = await upsertMatch(s, detail);
      if (result) {
        const tag = result.playerCount ? ` (${result.playerCount} players)` : ' (lineup pending)';
        console.log(`✓ synced ${slug} → local match id ${result.matchId}${tag}`);
        if (!result.playerCount) noLineup++;
        ok++;
      }
    } catch (e) {
      console.error(`✗ ${slug}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} succeeded (${noLineup} lineup pending), ${fail} failed, ${skipped} skipped (no slug).`);
  if (noLineup > 0) console.log('Note: lineups may appear closer to match start — re-run later.');
  process.exit(0);
}

main().catch((e) => { console.error('Sync failed:', e.message || e); process.exit(1); });
