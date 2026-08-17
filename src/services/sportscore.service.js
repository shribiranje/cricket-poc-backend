/**
 * SportScore poller — free public API at sportscore.com (no key required).
 * ------------------------------------------------------------------------
 * Same contract as simulator/sportmonks/rapidapi: start() / stop() / tickOnce().
 * Endpoints (from the official OpenAPI spec / sportscore-mcp source):
 *   GET /api/widget/matches/?sport=cricket&limit=N       live + recent matches
 *   GET /api/widget/match/?sport=cricket&slug=<slug>     match detail
 *   GET /api/widget/team/?sport=cricket&slug=<slug>      team schedule
 *   GET /api/widget/player/?sport=cricket&slug=<slug>    player stats
 *
 * HARD CONSTRAINTS you must respect (from sportscore.com/developers/terms/):
 *   1. Rate limit: ~1000 requests / 24h / IP on the free tier, with 60-second
 *      edge caching. Polling faster than 60s is wasted quota — responses are
 *      cached. Default poll here is 60s and a rolling 24h budget guard stops
 *      requests at SPORTSCORE_DAILY_BUDGET (default 900) to leave headroom.
 *      Budget math: one live match ≈ 1 req/min ≈ 1440/day > budget. TWO live
 *      matches will exhaust the free tier. For production volume you must
 *      contact api@sportscore.com for a commercial arrangement.
 *   2. Attribution: a visible "Powered by SportScore" link is required on any
 *      end-user page showing their data (added to the frontend toolbar).
 *
 * DATA-SHAPE CAVEAT — READ BEFORE TRUSTING SCORING:
 *   SportScore is a general live-scores API (football-first). Whether cricket
 *   match detail includes a per-player batting/bowling scorecard is NOT
 *   documented. The three mappers marked ADJUST below are written against the
 *   most plausible field names and MUST be finalized against real payloads:
 *       npm run sportscore:probe
 *   If probe-output shows no per-player scorecard, this source can manage
 *   match lifecycle (UPCOMING→LIVE→COMPLETED) but CANNOT produce fantasy
 *   points, and calcPoints() will yield 0 for everyone. In that case keep
 *   SPORTMONKS or RAPIDAPI as DATA_SOURCE. See README-SPORTSCORE.md.
 */
const pool = require('../config/db');
const config = require('../config');
const { calcPoints } = require('./scoring.service');
const { recalcAllForMatch } = require('./userTeamScore.service');

const C = config.sportscore;
let timer = null;

/* ------------------------------------------------------------------ */
/* Rolling 24h request budget                                          */
/* ------------------------------------------------------------------ */
const reqLog = []; // timestamps (ms) of requests in the last 24h

function budgetRemaining() {
  const cutoff = Date.now() - 24 * 3600_000;
  while (reqLog.length && reqLog[0] < cutoff) reqLog.shift();
  return C.dailyBudget - reqLog.length;
}

async function ssFetch(path, query = {}) {
  if (budgetRemaining() <= 0) {
    throw new Error(`daily request budget (${C.dailyBudget}) exhausted — skipping until window rolls`);
  }
  const url = new URL(C.baseUrl + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  reqLog.push(Date.now());
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': C.userAgent },
  });
  const text = await res.text();
  if (res.status === 429) throw new Error('SportScore 429 — reduce polling or contact api@sportscore.com');
  if (!res.ok) throw new Error(`SportScore ${res.status} for ${path}: ${text.slice(0, 150)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`SportScore non-JSON for ${path}: ${text.slice(0, 150)}`); }
}

/* ------------------------------------------------------------------ */
/* Mappers — finalize against `npm run sportscore:probe` output        */
/* ------------------------------------------------------------------ */

/** ADJUST: external match status string -> our lifecycle status. */
function mapStatus(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (!s || /not.?started|scheduled|upcoming|fixture|ns\b/.test(s)) return 'UPCOMING';
  if (/finish|ended|complete|result|aband|cancel|postp|awarded|ft\b/.test(s)) return 'COMPLETED';
  return 'LIVE'; // in progress / innings break / rain delay etc.
}

/**
 * ADJUST: extract the per-player batting rows from a match-detail payload.
 * Tries the plausible shapes: detail.scorecard.innings[].batting[],
 * detail.innings[].batting[], detail.batting[].
 * Each row is normalized to { slug, name, runs, balls, fours, sixes, dismissedBy }.
 */
function extractBatting(detail) {
  const innings =
    detail?.scorecard?.innings ||
    detail?.innings ||
    (Array.isArray(detail?.batting) ? [{ batting: detail.batting }] : []);
  const rows = [];
  for (const inn of innings || []) {
    for (const b of inn?.batting || []) {
      rows.push({
        slug: b.slug || b.player_slug || b.player?.slug || null,
        name: b.name || b.player_name || b.player?.name || null,
        runs: +(b.runs ?? b.score ?? 0) || 0,
        balls: +(b.balls ?? b.balls_faced ?? 0) || 0,
        fours: +(b.fours ?? b.four_x ?? 0) || 0,
        sixes: +(b.sixes ?? b.six_x ?? 0) || 0,
        // fielder credited with the catch/stumping, if present
        fielderSlug: b.fielder_slug || b.catch_by?.slug || null,
      });
    }
  }
  return rows;
}

/** ADJUST: same idea for bowling rows -> { slug, name, overs, runsConceded, wickets }. */
function extractBowling(detail) {
  const innings =
    detail?.scorecard?.innings ||
    detail?.innings ||
    (Array.isArray(detail?.bowling) ? [{ bowling: detail.bowling }] : []);
  const rows = [];
  for (const inn of innings || []) {
    for (const b of inn?.bowling || []) {
      rows.push({
        slug: b.slug || b.player_slug || b.player?.slug || null,
        name: b.name || b.player_name || b.player?.name || null,
        overs: b.overs ?? b.overs_bowled ?? 0,
        runsConceded: +(b.runs ?? b.runs_conceded ?? b.conceded ?? 0) || 0,
        wickets: +(b.wickets ?? b.wkts ?? 0) || 0,
      });
    }
  }
  return rows;
}

function oversToBalls(overs) {
  const n = Number(overs) || 0;
  const whole = Math.floor(n);
  return whole * 6 + Math.round((n - whole) * 10);
}

/* ------------------------------------------------------------------ */
/* DB helpers                                                          */
/* ------------------------------------------------------------------ */

async function getTrackedMatches() {
  const [rows] = await pool.query(
    `SELECT id, external_slug, status
       FROM matches
      WHERE external_slug IS NOT NULL
        AND status IN ('LIVE', 'UPCOMING')
        AND (status = 'LIVE' OR start_time <= DATE_ADD(NOW(), INTERVAL 15 MINUTE))`
  );
  return rows;
}

async function getInternalPlayerId(matchId, slug, name) {
  // Prefer slug match; fall back to exact-name match within the match squad
  // (probe may reveal that scorecard rows carry names but not slugs).
  if (slug) {
    const [[bySlug]] = await pool.query('SELECT id FROM players WHERE external_slug = ?', [slug]);
    if (bySlug) return bySlug.id;
  }
  if (name) {
    const [[byName]] = await pool.query(
      `SELECT p.id FROM players p
        JOIN match_players mp ON mp.player_id = p.id
       WHERE mp.match_id = ? AND p.name = ? LIMIT 1`,
      [matchId, name]
    );
    if (byName) return byName.id;
  }
  return null;
}

async function transitionToLive(matchId, externalStatus) {
  await pool.query(
    `UPDATE matches SET status = 'LIVE', external_status = ?
       WHERE id = ? AND status != 'COMPLETED'`,
    [externalStatus, matchId]
  );
  await pool.query('UPDATE user_teams SET is_locked = 1 WHERE match_id = ?', [matchId]);
  await pool.query(
    `INSERT IGNORE INTO player_match_stats (match_id, player_id)
       SELECT match_id, player_id FROM match_players WHERE match_id = ?`,
    [matchId]
  );
}

async function transitionToCompleted(matchId, externalStatus) {
  await pool.query(
    `UPDATE matches SET status = 'COMPLETED', external_status = ? WHERE id = ?`,
    [externalStatus, matchId]
  );
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                           */
/* ------------------------------------------------------------------ */

let warnedNoScorecard = false;

async function ingestDetail(matchId, detail) {
  const rawStatus = detail?.status || detail?.match_status || detail?.state || '';
  const mapped = mapStatus(rawStatus);
  if (mapped === 'LIVE') await transitionToLive(matchId, String(rawStatus));
  else if (mapped === 'COMPLETED') {
    await transitionToLive(matchId, String(rawStatus));
    await transitionToCompleted(matchId, String(rawStatus));
  } else return;

  const batting = extractBatting(detail);
  const bowling = extractBowling(detail);

  if (!batting.length && !bowling.length) {
    if (!warnedNoScorecard) {
      warnedNoScorecard = true;
      console.warn(
        '[sportscore] ⚠ match detail contained NO per-player scorecard rows. ' +
        'Fantasy points cannot be computed from this source. Run ' +
        '`npm run sportscore:probe`, inspect probe-output/, and either fix the ' +
        'ADJUST mappers in sportscore.service.js or revert DATA_SOURCE to ' +
        'SPORTMONKS/RAPIDAPI. (This warning prints once per process.)'
      );
    }
    return; // lifecycle still managed above; scoring skipped
  }

  for (const b of batting) {
    const pid = await getInternalPlayerId(matchId, b.slug, b.name);
    if (!pid) continue;
    await pool.query(
      `INSERT INTO player_match_stats (match_id, player_id, runs, balls_faced, fours, sixes)
         VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         runs = VALUES(runs), balls_faced = VALUES(balls_faced),
         fours = VALUES(fours), sixes = VALUES(sixes)`,
      [matchId, pid, b.runs, b.balls, b.fours, b.sixes]
    );
  }

  for (const b of bowling) {
    const pid = await getInternalPlayerId(matchId, b.slug, b.name);
    if (!pid) continue;
    await pool.query(
      `INSERT INTO player_match_stats (match_id, player_id, balls_bowled, runs_conceded, wickets)
         VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         balls_bowled = VALUES(balls_bowled),
         runs_conceded = VALUES(runs_conceded),
         wickets = VALUES(wickets)`,
      [matchId, pid, oversToBalls(b.overs), b.runsConceded, b.wickets]
    );
  }

  // Catches: recount from batting dismissal credits (same approach as sportmonks)
  await pool.query(`UPDATE player_match_stats SET catches = 0 WHERE match_id = ?`, [matchId]);
  for (const b of batting) {
    if (!b.fielderSlug) continue;
    const fpid = await getInternalPlayerId(matchId, b.fielderSlug, null);
    if (!fpid) continue;
    await pool.query(
      `INSERT INTO player_match_stats (match_id, player_id, catches)
         VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE catches = catches + 1`,
      [matchId, fpid]
    );
  }

  const [statRows] = await pool.query(`SELECT * FROM player_match_stats WHERE match_id = ?`, [matchId]);
  for (const s of statRows) {
    const pts = calcPoints(s);
    await pool.query(
      `UPDATE player_match_stats SET points = ? WHERE match_id = ? AND player_id = ?`,
      [pts, matchId, s.player_id]
    );
  }

  await recalcAllForMatch(matchId);
}

async function tickOnce() {
  const matches = await getTrackedMatches();
  if (!matches.length) return;

  const remaining = budgetRemaining();
  if (remaining < matches.length) {
    console.warn(`[sportscore] budget low (${remaining} left, ${matches.length} live matches) — polling subset`);
  }

  for (const m of matches.slice(0, Math.max(0, remaining))) {
    try {
      const detail = await ssFetch('/api/widget/match/', { sport: 'cricket', slug: m.external_slug });
      await ingestDetail(m.id, detail);
    } catch (e) {
      console.error(`[sportscore] match ${m.external_slug} failed:`, e.message);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function start() {
  if (config.dataSource !== 'SPORTSCORE') {
    console.log('[sportscore] not the active data source, skipping start');
    return;
  }
  if (timer) return;
  if (C.pollLiveMs < 60_000) {
    console.warn('[sportscore] pollLiveMs < 60s is wasted quota (60s edge cache upstream) — clamping to 60s');
  }
  const interval = Math.max(C.pollLiveMs, 60_000);
  console.log(`[sportscore] starting poller every ${interval}ms (daily budget ${C.dailyBudget})`);
  const loop = async () => {
    try { await tickOnce(); }
    catch (e) { console.error('[sportscore] tick error', e); }
  };
  loop();
  timer = setInterval(loop, interval);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start, stop, tickOnce, ssFetch,
  mapStatus, extractBatting, extractBowling, oversToBalls, budgetRemaining,
};
