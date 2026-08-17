/**
 * RapidAPI poller — Cricket Live Line (cricket-live-line1.p.rapidapi.com).
 * Ball-by-ball: GET /match/{id}/commentary
 * Scorecard:    GET /match/{id}/scorecard
 * Lists:        GET /liveMatches , GET /upcomingMatches
 *
 * Auto-poll is admin-timed (15m / 1h / 2h sessions) — not env-driven.
 * Poll interval / min-gap / scorecard cadence are admin settings (app_settings),
 * with RAPIDAPI_* env values as fallbacks.
 *
 * Same contract as simulator/sportmonks: start() / stop() / tickOnce().
 */
const pool = require('../config/db');
const config = require('../config');
const { AppError } = require('../utils/response');
const { toMysqlUtc } = require('../utils/datetime');
const { calcPoints } = require('./scoring.service');
const { recalcAllForMatch } = require('./userTeamScore.service');
const lifecycle = require('./matchLifecycle.service');
const prediction = require('./prediction.service');
const appSettings = require('./appSettings.service');

const C = config.rapidapi;
const ALLOWED_POLL_MINUTES = new Set([15, 60, 120]);

let timer = null;
let expiryTimer = null;
let tickCount = 0;
let backoffUntil = 0;
let consecutive429 = 0;
let lastRequestAt = 0;
let fetchChain = Promise.resolve();
/** @type {number|null} */
let activeSessionId = null;

/** Runtime knobs (loaded from app_settings; env as fallback). */
let runtimePollLiveMs = C.pollLiveMs || 120000;
let runtimeMinGapMs = C.minGapMs || 2500;
let runtimeScorecardEveryN = 4;

async function refreshRuntimeSettings() {
  runtimePollLiveMs = await appSettings.getPollLiveMs();
  runtimeMinGapMs = await appSettings.getMinGapMs();
  runtimeScorecardEveryN = await appSettings.getScorecardEveryN();
}

function matchEp(template, matchId) {
  return String(template || '').replace(/\{id\}/g, String(matchId));
}

function backoffRemainingMs() {
  return Math.max(0, backoffUntil - Date.now());
}

function setBackoff(waitMs, reason) {
  backoffUntil = Date.now() + waitMs;
  console.warn(`[rapidapi] ${reason} — next attempt in ${Math.ceil(waitMs / 1000)}s`);
}

/** Space RapidAPI calls so free-tier RPM limits are less likely to trip. */
async function waitMinGap() {
  const gap = Math.max(0, runtimeMinGapMs || 0);
  if (!gap) return;
  const wait = lastRequestAt + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function raFetch(path, query = {}) {
  // Serialize all outbound RapidAPI traffic (poller + admin sync share one lane).
  const run = fetchChain.then(() => raFetchUnlocked(path, query));
  fetchChain = run.catch(() => {});
  return run;
}

async function raFetchUnlocked(path, query = {}) {
  if (!C.key) throw new Error('RAPIDAPI_KEY not configured');
  const rem = backoffRemainingMs();
  if (rem > 0) {
    const err = new Error(`rate-limit backoff active — retry in ${Math.ceil(rem / 1000)}s`);
    err.code = 'RATE_LIMIT_BACKOFF';
    err.retryAfterMs = rem;
    throw err;
  }

  await waitMinGap();
  lastRequestAt = Date.now();
  const started = Date.now();

  const url = new URL(C.baseUrl + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'X-RapidAPI-Key': C.key,
        'X-RapidAPI-Host': C.host,
      },
    });
  } catch (netErr) {
    await logApiCall({
      path,
      httpStatus: null,
      ok: false,
      durationMs: Date.now() - started,
      errorMessage: netErr.message,
    });
    throw netErr;
  }

  const durationMs = Date.now() - started;

  // Count every outbound hit (including 429) against the active admin poll session.
  bumpSessionApiCall().catch((e) => console.warn(`[rapidapi] api_calls bump: ${e.message}`));

  if (res.status === 429) {
    consecutive429 += 1;
    const body = await res.text().catch(() => '');
    const retryAfter = Number(res.headers.get('retry-after'));
    // Exponential: 2m, 4m, 8m… capped at 30m. Daily-quota 429s often never clear sooner.
    const expMs = Math.min(30 * 60_000, 120_000 * (2 ** Math.min(consecutive429 - 1, 4)));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.max(retryAfter * 1000, expMs)
      : expMs;
    const snippet = body.replace(/\s+/g, ' ').slice(0, 120);
    setBackoff(waitMs, `429 on ${path}${snippet ? ` (${snippet})` : ''}`);
    await logApiCall({
      path,
      httpStatus: 429,
      ok: false,
      durationMs,
      errorMessage: snippet || 'rate limited',
    });
    const err = new Error(`RapidAPI 429 — backing off ${Math.ceil(waitMs / 1000)}s (streak ${consecutive429})`);
    err.code = 'RATE_LIMIT';
    err.retryAfterMs = waitMs;
    throw err;
  }

  consecutive429 = 0;

  if (res.status === 403) {
    await logApiCall({
      path,
      httpStatus: 403,
      ok: false,
      durationMs,
      errorMessage: 'forbidden / not subscribed',
    });
    throw new Error(
      `RapidAPI 403 for ${path} on ${C.host} — subscribe to Cricket Live Line on RapidAPI`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    await logApiCall({
      path,
      httpStatus: res.status,
      ok: false,
      durationMs,
      errorMessage: body.replace(/\s+/g, ' ').slice(0, 150),
    });
    throw new Error(`RapidAPI ${res.status} for ${path}: ${body.slice(0, 150)}`);
  }

  await logApiCall({
    path,
    httpStatus: res.status,
    ok: true,
    durationMs,
  });
  return res.json();
}

function classifyEndpoint(path = '') {
  const p = String(path);
  if (p.includes('/commentary')) return 'commentary';
  if (p.includes('/scorecard')) return 'scorecard';
  if (p.includes('liveMatches') || p === C.ep.live) return 'live';
  if (p.includes('upcomingMatches') || p === C.ep.fixtures) return 'fixtures';
  return 'other';
}

async function logApiCall({ path, httpStatus, ok, durationMs, errorMessage = null }) {
  try {
    await pool.query(
      `INSERT INTO rapidapi_call_log
         (path, endpoint_kind, http_status, ok, duration_ms, session_id, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(path).slice(0, 255),
        classifyEndpoint(path),
        httpStatus,
        ok ? 1 : 0,
        durationMs || 0,
        activeSessionId,
        errorMessage ? String(errorMessage).slice(0, 255) : null,
      ]
    );
  } catch (e) {
    // Don't break gameplay if analytics table is missing / write fails.
    console.warn(`[rapidapi] call log write failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Mappers — Cricket Live Line payloads                                */
/* ------------------------------------------------------------------ */

/** External match status string -> our lifecycle status. */
function mapStatus(s = '') {
  const t = String(s).toLowerCase();
  if (/complete|finished|won by|draw|tie|aband|no result|postp|cancl/.test(t)) return 'COMPLETED';
  if (/live|progress|innings break|rain|delay|stump/.test(t)) return 'LIVE';
  return 'UPCOMING';
}

/**
 * Commentary (type=1 balls) -> ordered deliveries.
 * Shape: data["1 Inning"]["6 over"] = [{ type:1, inning, data:{ overs:"6.1", runs, wicket, wides... } }]
 */
function extractDeliveries(json) {
  const root = json?.data;
  if (!root || typeof root !== 'object') return [];
  const out = [];
  for (const innBlock of Object.values(root)) {
    if (!innBlock || typeof innBlock !== 'object') continue;
    for (const balls of Object.values(innBlock)) {
      if (!Array.isArray(balls)) continue;
      for (const c of balls) {
        if (Number(c.type) !== 1 || !c.data) continue; // type 2 = end-of-over summary
        const overFloat = Number(c.data.overs ?? c.data.over);
        if (!Number.isFinite(overFloat)) continue;
        const over_number = Math.floor(overFloat);
        const ball_number = Math.round((overFloat - over_number) * 10) || 0;
        if (ball_number < 1 || ball_number > 6) continue;
        const wides = Number(c.data.wides || 0);
        const noballs = Number(c.data.noballs || 0);
        const byes = Number(c.data.byes || 0);
        const legbyes = Number(c.data.legbyes || 0);
        const isExtra = wides > 0 || noballs > 0 || byes > 0 || legbyes > 0;
        const isWicket = Boolean(c.data.wicket && String(c.data.wicket).trim());
        out.push({
          innings: Number(c.inning ?? c.data.inning ?? 1),
          over_number,
          ball_number,
          runs: Number(c.data.runs ?? 0),
          isWicket,
          isExtra,
          batsmanExtId: null,
          bowlerExtId: null,
        });
      }
    }
  }
  return out.sort((a, b) =>
    a.innings - b.innings || a.over_number - b.over_number || a.ball_number - b.ball_number
  );
}

/** Scorecard -> batting/bowling rows keyed by external player id. */
function extractScorecard(json) {
  const card = json?.data?.scorecard || {};
  const batting = [];
  const bowling = [];
  for (const inn of Object.values(card)) {
    if (!inn || typeof inn !== 'object') continue;
    for (const b of inn.batsman || []) {
      batting.push({
        ext: b.player_id ?? b.id,
        runs: Number(b.run ?? b.runs ?? 0),
        balls_faced: Number(b.ball ?? b.balls ?? 0),
        fours: Number(b.fours ?? 0),
        sixes: Number(b.sixes ?? 0),
      });
    }
    for (const w of inn.bolwer || inn.bowler || []) {
      const overs = Number(w.over ?? w.overs ?? 0);
      bowling.push({
        ext: w.player_id ?? w.id,
        balls_bowled: Math.floor(overs) * 6 + Math.round((overs % 1) * 10),
        runs_conceded: Number(w.run ?? w.runs ?? 0),
        wickets: Number(w.wicket ?? w.wickets ?? 0),
      });
    }
  }
  return { batting, bowling };
}

function teamFromRow(row, side) {
  // side: 'a' | 'b'
  const id = row[`team_${side}_id`] ?? row[`team${side}Id`];
  const name = row[`team_${side}`] ?? row[`team${side}`];
  const short = row[`team_${side}_short`] ?? row[`team${side}Short`] ?? name;
  if (id == null || !name) return null;
  return { teamId: Number(id), teamName: String(name), teamSName: String(short).slice(0, 10) };
}

/**
 * Cricket Live Line returns wall-clock times in India Standard Time (IST, UTC+5:30),
 * e.g. date_wise "24 Jul 2026, Thursday" + match_time "01:00 PM".
 * Parsing those as UTC made starts ~5.5h late; combined with MySQL FROM_UNIXTIME under a
 * non-UTC session TZ that error often shrank to ~30m (what you saw vs Cricbuzz).
 */
function parseStartMs(row) {
  const wise = row.date_wise || row.match_date_wise;
  const time = row.match_time || '12:00 PM';
  if (wise) {
    const m = String(wise).match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
    if (m) {
      const t = Date.parse(`${m[1]} ${m[2]} ${m[3]} ${time} GMT+0530`);
      if (Number.isFinite(t)) return t;
    }
  }
  if (row.match_date) {
    const t = Date.parse(`${row.match_date} 2026 ${time} GMT+0530`);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function toFixtureRow(row, { preferLive = false } = {}) {
  if (!row?.match_id) return null;
  const team1 = teamFromRow(row, 'a');
  const team2 = teamFromRow(row, 'b');
  if (!team1 || !team2) return null;
  const status = preferLive
    ? 'LIVE'
    : mapStatus(row.match_status || row.status || '');
  const format = String(row.match_type || row.matchs || 'T20').toUpperCase().includes('TEST')
    ? 'TEST'
    : String(row.match_type || 'T20').toUpperCase().includes('ODI')
      ? 'ODI'
      : 'T20';
  return {
    matchId: Number(row.match_id),
    format,
    startMs: parseStartMs(row),
    team1,
    team2,
    venue: row.venue || null,
    status: status === 'COMPLETED' ? 'UPCOMING' : status,
  };
}

/** Live rows from /liveMatches */
function extractLive(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map((r) => toFixtureRow(r, { preferLive: true })).filter(Boolean);
}

/** Upcoming rows from /upcomingMatches */
function extractFixtures(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map((r) => toFixtureRow(r, { preferLive: false })).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                           */
/* ------------------------------------------------------------------ */

const ENGINE_TYPE = (d) =>
  d.isWicket ? 'WICKET'
  : d.isExtra ? 'EXTRA'
  : d.runs === 0 ? 'DOT_BALL'
  : d.runs === 4 ? 'FOUR'
  : d.runs === 6 ? 'SIX'
  : `RUN_${d.runs}`;

async function playerIdMap(matchId) {
  const [rows] = await pool.query(
    `SELECT p.id, p.external_id FROM players p
      JOIN match_players mp ON mp.player_id = p.id
     WHERE mp.match_id = ? AND p.external_id IS NOT NULL`,
    [matchId]
  );
  return new Map(rows.map((r) => [String(r.external_id), r.id]));
}

async function ingestCommentary(match) {
  const json = await raFetch(matchEp(C.ep.commentary, match.external_id));

  const [[curRow]] = await pool.query(
    'SELECT * FROM rapidapi_cursor WHERE match_id = ?', [match.id]
  );
  const cur = curRow || {
    innings: 1, over_number: 0, ball_number: 0, curr_over_runs: 0, curr_over_wicket: 0,
  };
  const after = (d) =>
    d.innings > cur.innings ||
    (d.innings === cur.innings &&
      d.over_number * 6 + d.ball_number > cur.over_number * 6 + cur.ball_number);

  const fresh = extractDeliveries(json).filter(after);
  if (fresh.length) {
    const players = await playerIdMap(match.id);
    for (const d of fresh) {
      // Over/innings rollover: settle the over the cursor was accumulating.
      const rolled = d.innings !== cur.innings || d.over_number !== cur.over_number;
      if (rolled && cur.ball_number > 0) {
        await prediction.resolveOver(match.id, cur.innings, cur.over_number, {
          totalRuns: cur.curr_over_runs, hadWicket: !!cur.curr_over_wicket,
        });
        cur.curr_over_runs = 0;
        cur.curr_over_wicket = 0;
      }

      const pid = players.get(String(d.batsmanExtId));
      if (pid) {
        await pool.query(
          'INSERT INTO match_events (match_id, player_id, event_type, value, meta) VALUES (?, ?, ?, ?, ?)',
          [match.id, pid, ENGINE_TYPE(d), d.isWicket ? 0 : d.runs,
           JSON.stringify({ innings: d.innings, over: d.over_number, ball: d.ball_number,
                            source: 'RAPIDAPI', bowlerExt: d.bowlerExtId })]
        );
      }

      await prediction.resolveDelivery(match.id, d);

      cur.innings = d.innings;
      cur.over_number = d.over_number;
      cur.ball_number = d.ball_number;
      cur.curr_over_runs += d.isExtra ? d.runs || 1 : d.runs;
      cur.curr_over_wicket = cur.curr_over_wicket || (d.isWicket ? 1 : 0);
      if (d.ball_number === 6) {
        await prediction.resolveOver(match.id, d.innings, d.over_number, {
          totalRuns: cur.curr_over_runs, hadWicket: !!cur.curr_over_wicket,
        });
        cur.curr_over_runs = 0;
        cur.curr_over_wicket = 0;
      }
    }
    await pool.query(
      `INSERT INTO rapidapi_cursor
         (match_id, innings, over_number, ball_number, curr_over_runs, curr_over_wicket)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE innings=VALUES(innings), over_number=VALUES(over_number),
         ball_number=VALUES(ball_number), curr_over_runs=VALUES(curr_over_runs),
         curr_over_wicket=VALUES(curr_over_wicket)`,
      [match.id, cur.innings, cur.over_number, cur.ball_number,
       cur.curr_over_runs, cur.curr_over_wicket]
    );
  }

  // Cricket Live Line: status is boolean on envelope; infer from balls / scorecard result.
  if (json?.data?.result || /won by|match ended|finished/i.test(JSON.stringify(json?.data?.result || ''))) {
    return 'COMPLETED';
  }
  if (extractDeliveries(json).length > 0) return 'LIVE';
  if (json?.status === false) return 'UPCOMING';
  return mapStatus(json?.data?.match_status || json?.msg || '');
}

async function syncScorecard(match) {
  const json = await raFetch(matchEp(C.ep.scorecard, match.external_id));
  const { batting, bowling } = extractScorecard(json);
  if (!batting.length && !bowling.length) return;
  const players = await playerIdMap(match.id);

  for (const b of batting) {
    const pid = players.get(String(b.ext));
    if (!pid) continue;
    await pool.query(
      `INSERT INTO player_match_stats (match_id, player_id, runs, balls_faced, fours, sixes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE runs=VALUES(runs), balls_faced=VALUES(balls_faced),
         fours=VALUES(fours), sixes=VALUES(sixes)`,
      [match.id, pid, b.runs, b.balls_faced, b.fours, b.sixes]
    );
  }
  for (const w of bowling) {
    const pid = players.get(String(w.ext));
    if (!pid) continue;
    await pool.query(
      `INSERT INTO player_match_stats (match_id, player_id, balls_bowled, runs_conceded, wickets)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE balls_bowled=VALUES(balls_bowled),
         runs_conceded=VALUES(runs_conceded), wickets=VALUES(wickets)`,
      [match.id, pid, w.balls_bowled, w.runs_conceded, w.wickets]
    );
  }

  const [stats] = await pool.query(
    'SELECT * FROM player_match_stats WHERE match_id = ?', [match.id]
  );
  for (const s of stats) {
    const pts = calcPoints(s);
    if (pts !== Number(s.points)) {
      await pool.query(
        'UPDATE player_match_stats SET points = ? WHERE match_id = ? AND player_id = ?',
        [pts, match.id, s.player_id]
      );
    }
  }
  await recalcAllForMatch(match.id);
}

async function tickOnce() {
  // Skip entire poll cycle while cooling down from a 429 — avoids log spam.
  if (backoffRemainingMs() > 0) return;
  if (!activeSessionId) return;

  tickCount += 1;
  // Only LIVE matches — upcoming start is handled by scheduler / admin sync.
  // Cuts request volume vs polling every near-upcoming fixture every cycle.
  const [matches] = await pool.query(
    `SELECT id, external_id, status FROM matches
      WHERE external_id IS NOT NULL AND status = 'LIVE'`
  );
  for (const m of matches) {
    try {
      const extStatus = await ingestCommentary(m);

      // Scorecard is heavier — refresh every Nth tick (admin setting).
      const everyN = Math.max(1, runtimeScorecardEveryN || 4);
      if (extStatus !== 'UPCOMING' && (tickCount - 1) % everyN === 0) await syncScorecard(m);

      if (extStatus === 'COMPLETED') {
        // Settle a partially-bowled final over before lifecycle voids the rest.
        const [[cur]] = await pool.query(
          'SELECT * FROM rapidapi_cursor WHERE match_id = ?', [m.id]
        );
        if (cur && cur.ball_number > 0 && cur.ball_number < 6) {
          await prediction.resolveOver(m.id, cur.innings, cur.over_number, {
            totalRuns: cur.curr_over_runs, hadWicket: !!cur.curr_over_wicket,
          });
        }
        try { await lifecycle.completeMatch(m.id); } // voids remaining OPEN predictions
        catch (e) { if (e.code !== 'CANNOT_COMPLETE') throw e; }
        await pool.query('UPDATE matches SET external_status = ? WHERE id = ?', ['Finished', m.id]);
      }
    } catch (e) {
      if (e.code === 'RATE_LIMIT' || e.code === 'RATE_LIMIT_BACKOFF') {
        console.warn(`[rapidapi] ${e.message}`);
        return; // stop the rest of this tick; next ticks skip until backoff ends
      }
      console.error(`[rapidapi] match ${m.id}: ${e.message}`);
    }
  }
}

const isTBC = (t) => !t || !t.teamId || /^(TBC|TBA)$/i.test(t.teamSName || '');

async function upsertTeam(t) {
  await pool.query(
    `INSERT INTO teams (external_id, name, short_name)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), short_name = VALUES(short_name)`,
    [t.teamId, t.teamName, String(t.teamSName || t.teamName).slice(0, 10)]
  );
  const [[row]] = await pool.query('SELECT id FROM teams WHERE external_id = ?', [t.teamId]);
  return row.id;
}

/**
 * Wipe match runtime rows + matches (keeps users/teams/players catalog).
 * Use before a fresh RapidAPI import so the demo DC vs LSG fixture is gone.
 */
async function clearMatches() {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of [
    'user_team_players',
    'user_teams',
    'predictions',
    'rapidapi_cursor',
    'match_events',
    'player_match_stats',
    'match_state',
    'match_players',
    'matches',
  ]) {
    await pool.query(`DELETE FROM \`${table}\``);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log('[rapidapi] cleared all matches and match-related rows');
}

/**
 * Import live + upcoming fixtures.
 * Options: { limit } — max matches to keep (live first, then soonest start).
 * npm run rapidapi:sync -- --limit 10
 */
async function syncFixtures({ limit } = {}) {
  const [liveJson, scheduleJson] = await Promise.all([
    raFetch(C.ep.live).catch((e) => {
      console.warn(`[rapidapi] live fetch failed: ${e.message}`);
      return { response: [] };
    }),
    raFetch(C.ep.fixtures),
  ]);

  const live = extractLive(liveJson);
  const scheduled = extractFixtures(scheduleJson);
  const byId = new Map();

  // Live wins over schedule for the same matchId
  for (const f of scheduled) byId.set(f.matchId, { ...f, status: f.status || 'UPCOMING' });
  for (const f of live) byId.set(f.matchId, { ...f, status: 'LIVE' });

  let candidates = [...byId.values()]
    .filter((f) => f.matchId && Number.isFinite(f.startMs) && !isTBC(f.team1) && !isTBC(f.team2))
    .sort((a, b) => {
      const liveRank = (s) => (s === 'LIVE' ? 0 : 1);
      return liveRank(a.status) - liveRank(b.status) || a.startMs - b.startMs;
    });

  const max = Number.isFinite(limit) && limit > 0 ? limit : null;
  if (max) candidates = candidates.slice(0, max);

  let imported = 0;
  let skipped = byId.size - candidates.length;

  for (const f of candidates) {
    const [aId, bId] = [await upsertTeam(f.team1), await upsertTeam(f.team2)];
    const status = f.status === 'LIVE' ? 'LIVE' : 'UPCOMING';
    await pool.query(
      `INSERT INTO matches
         (external_id, team_a_id, team_b_id, format, venue, start_time, timezone, auto_start, status)
       VALUES (?, ?, ?, ?, ?, ?, 'UTC', 0, ?)
       ON DUPLICATE KEY UPDATE
         start_time = VALUES(start_time),
         venue = VALUES(venue),
         status = IF(VALUES(status) = 'LIVE', 'LIVE', status)`,
      [f.matchId, aId, bId, f.format, f.venue, toMysqlUtc(new Date(f.startMs).toISOString()), status]
    );
    imported += 1;
    console.log(
      `  + ${status.padEnd(8)} ${f.team1.teamSName || f.team1.teamName} vs ${f.team2.teamSName || f.team2.teamName}`
      + `  #${f.matchId}  ${new Date(f.startMs).toISOString()}`
    );
  }

  console.log(
    `[rapidapi] synced: ${imported} imported`
    + (max ? ` (limit ${max})` : '')
    + `, ${skipped} skipped/not selected`
    + `, live feed had ${live.length}`
  );
  return {
    imported,
    skipped,
    liveFeed: live.length,
    limit: max,
    cleaned: false,
  };
}

async function syncFixturesAdmin({ clean = false, limit } = {}) {
  if (!C.key) throw new AppError(400, 'NO_KEY', 'RAPIDAPI_KEY not configured');
  if (clean) await clearMatches();
  const resolvedLimit = limit != null
    ? Number(limit)
    : await appSettings.getSyncFixtureLimit();
  const result = await syncFixtures({ limit: resolvedLimit });
  return { ...result, cleaned: !!clean };
}

/**
 * Admin Sync button — pull RapidAPI and update everything for external fixtures:
 *   1. Refresh schedule metadata (start_time / venue)
 *   2. Flip UPCOMING → LIVE / LIVE → COMPLETED from live board + commentary
 *   3. Ingest commentary + scorecard for LIVE matches (settles over-bets)
 *
 * No manual Start/Complete needed for RapidAPI matches.
 */
async function syncStatuses() {
  if (!C.key) throw new Error('RAPIDAPI_KEY not configured');

  const [liveJson, scheduleJson] = await Promise.all([
    raFetch(C.ep.live).catch((e) => {
      console.warn(`[rapidapi] live fetch failed: ${e.message}`);
      return { response: [] };
    }),
    raFetch(C.ep.fixtures).catch((e) => {
      console.warn(`[rapidapi] schedule fetch failed: ${e.message}`);
      return { response: { schedules: [] } };
    }),
  ]);

  const liveIds = new Set(extractLive(liveJson).map((f) => String(f.matchId)));
  const scheduleById = new Map(
    extractFixtures(scheduleJson).map((f) => [String(f.matchId), f])
  );

  const [local] = await pool.query(
    `SELECT id, external_id, status, start_time FROM matches
      WHERE external_id IS NOT NULL
        AND status IN ('UPCOMING', 'LIVE')
      ORDER BY start_time ASC`
  );

  const summary = {
    checked: local.length,
    liveFeed: liveIds.size,
    started: [],
    completed: [],
    scored: [],
    refreshed: [],
    unchanged: [],
    errors: [],
  };

  for (const m of local) {
    const ext = String(m.external_id);
    try {
      const sched = scheduleById.get(ext);
      if (sched && Number.isFinite(sched.startMs)) {
        await pool.query(
          `UPDATE matches
              SET start_time = ?,
                  venue = COALESCE(?, venue)
            WHERE id = ?`,
          [toMysqlUtc(new Date(sched.startMs).toISOString()), sched.venue, m.id]
        );
        summary.refreshed.push(m.id);
      }

      let remote = liveIds.has(ext) ? 'LIVE' : null;
      let commentaryJson = null;

      // Probe commentary for status (and reuse for ingest below).
      const shouldProbe = !remote || m.status === 'LIVE' || liveIds.has(ext);
      if (shouldProbe) {
        try {
          commentaryJson = await raFetch(matchEp(C.ep.commentary, m.external_id));
          if (commentaryJson?.data?.result) remote = 'COMPLETED';
          else if (extractDeliveries(commentaryJson).length > 0) remote = 'LIVE';
          else if (liveIds.has(ext)) remote = 'LIVE';
        } catch (e) {
          if (!/404|not found/i.test(e.message)) {
            console.warn(`[rapidapi] status probe #${m.id}: ${e.message}`);
          }
          if (liveIds.has(ext)) remote = 'LIVE';
        }
      }

      let statusNow = m.status;

      if (remote === 'LIVE' && statusNow === 'UPCOMING') {
        await lifecycle.startMatch(m.id);
        await pool.query(
          'UPDATE matches SET external_status = ? WHERE id = ?',
          ['Live', m.id]
        );
        summary.started.push(m.id);
        statusNow = 'LIVE';
      }

      if (remote === 'COMPLETED' && statusNow !== 'COMPLETED') {
        if (statusNow === 'UPCOMING') {
          try {
            await lifecycle.startMatch(m.id);
            statusNow = 'LIVE';
          } catch (e) {
            if (e.code !== 'CANNOT_START') throw e;
          }
        }
        if (statusNow === 'LIVE') {
          // Ingest final balls before voiding open bets on complete
          try {
            await ingestCommentary({ id: m.id, external_id: m.external_id, status: 'LIVE' });
            await syncScorecard({ id: m.id, external_id: m.external_id });
            summary.scored.push(m.id);
          } catch (e) {
            console.warn(`[rapidapi] pre-complete ingest #${m.id}: ${e.message}`);
          }
          await lifecycle.completeMatch(m.id);
          await pool.query(
            'UPDATE matches SET external_status = ? WHERE id = ?',
            ['Finished', m.id]
          );
          summary.completed.push(m.id);
          continue;
        }
      }

      // LIVE gameplay: pull commentary + scorecard so over-bets settle
      if (statusNow === 'LIVE') {
        try {
          if (commentaryJson) {
            // ingestCommentary always re-fetches; call it for cursor/settle path
            await ingestCommentary({ id: m.id, external_id: m.external_id, status: 'LIVE' });
          } else {
            await ingestCommentary({ id: m.id, external_id: m.external_id, status: 'LIVE' });
          }
          await syncScorecard({ id: m.id, external_id: m.external_id });
          if (!summary.scored.includes(m.id)) summary.scored.push(m.id);
        } catch (e) {
          console.warn(`[rapidapi] score ingest #${m.id}: ${e.message}`);
          summary.errors.push({ id: m.id, message: e.message || String(e) });
        }
        continue;
      }

      summary.unchanged.push(m.id);
    } catch (e) {
      summary.errors.push({ id: m.id, message: e.message || String(e) });
    }
  }

  console.log(
    `[rapidapi] sync: checked=${summary.checked} liveFeed=${summary.liveFeed}`
    + ` started=${summary.started.length} scored=${summary.scored.length}`
    + ` completed=${summary.completed.length} errors=${summary.errors.length}`
  );
  return summary;
}

/**
 * Sync one RapidAPI match (for the Live match detail / bet panel).
 * Pulls commentary + scorecard, starts/completes via lifecycle, settles over-bets.
 */
async function syncMatch(matchId) {
  if (!C.key) throw new AppError(400, 'NO_KEY', 'RAPIDAPI_KEY not configured');

  const [[m]] = await pool.query(
    'SELECT id, external_id, status FROM matches WHERE id = ?',
    [matchId]
  );
  if (!m) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
  if (m.external_id == null) {
    throw new AppError(400, 'NOT_EXTERNAL',
      'This match is not linked to RapidAPI — use simulator autoplay instead');
  }
  if (m.status === 'COMPLETED') {
    const progress = await prediction.getMatchProgress(matchId);
    return { matchId, status: 'COMPLETED', started: false, scored: false, completed: false, progress };
  }

  const result = {
    matchId,
    status: m.status,
    started: false,
    scored: false,
    completed: false,
    progress: null,
  };

  let statusNow = m.status;
  let extStatus = 'UPCOMING';

  try {
    extStatus = await ingestCommentary({ id: m.id, external_id: m.external_id, status: statusNow });
  } catch (e) {
    if (e.code === 'RATE_LIMIT' || e.code === 'RATE_LIMIT_BACKOFF') {
      throw new AppError(429, 'RATE_LIMIT', e.message);
    }
    // Fall back to live board membership
    try {
      const liveJson = await raFetch(C.ep.live);
      const onLive = extractLive(liveJson).some((f) => String(f.matchId) === String(m.external_id));
      if (onLive) extStatus = 'LIVE';
      else throw e;
    } catch (e2) {
      if (e2.code === 'RATE_LIMIT' || e2.code === 'RATE_LIMIT_BACKOFF') {
        throw new AppError(429, 'RATE_LIMIT', e2.message);
      }
      throw new AppError(502, 'SYNC_FAILED', e2.message || e.message || 'RapidAPI sync failed');
    }
  }

  if (statusNow === 'UPCOMING' && extStatus !== 'UPCOMING') {
    try {
      await lifecycle.startMatch(m.id);
      result.started = true;
      statusNow = 'LIVE';
      await pool.query('UPDATE matches SET external_status = ? WHERE id = ?', ['Live', m.id]);
    } catch (e) {
      if (e.code !== 'CANNOT_START') throw e;
    }
  }

  if (statusNow === 'LIVE' || extStatus === 'LIVE' || extStatus === 'COMPLETED') {
    try {
      await syncScorecard({ id: m.id, external_id: m.external_id });
      result.scored = true;
    } catch (e) {
      console.warn(`[rapidapi] scorecard sync #${m.id}: ${e.message}`);
    }
  }

  if (extStatus === 'COMPLETED' && statusNow === 'LIVE') {
    const [[cur]] = await pool.query(
      'SELECT * FROM rapidapi_cursor WHERE match_id = ?', [m.id]
    );
    if (cur && cur.ball_number > 0 && cur.ball_number < 6) {
      await prediction.resolveOver(m.id, cur.innings, cur.over_number, {
        totalRuns: cur.curr_over_runs, hadWicket: !!cur.curr_over_wicket,
      });
    }
    try {
      await lifecycle.completeMatch(m.id);
      result.completed = true;
      statusNow = 'COMPLETED';
      await pool.query('UPDATE matches SET external_status = ? WHERE id = ?', ['Finished', m.id]);
    } catch (e) {
      if (e.code !== 'CANNOT_COMPLETE') throw e;
    }
  }

  result.status = statusNow;
  result.progress = await prediction.getMatchProgress(matchId);
  return result;
}

/* ------------------------------------------------------------------ */
/* Admin-timed auto-poll sessions                                      */
/* ------------------------------------------------------------------ */

async function bumpSessionApiCall() {
  if (!activeSessionId) return;
  await pool.query(
    `UPDATE rapidapi_poll_sessions
        SET api_calls = api_calls + 1
      WHERE id = ? AND status = 'ACTIVE'`,
    [activeSessionId]
  );
}

function clearExpiryTimer() {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function ensurePollerRunning() {
  if (timer) return;
  if (!C.key) return;
  const intervalMs = Math.max(15000, runtimePollLiveMs || 120000);
  timer = setInterval(
    () => tickOnce().catch((e) => console.error('[rapidapi]', e.message)),
    intervalMs
  );
  console.log(
    `[rapidapi] polling LIVE matches every ${intervalMs}ms`
    + ` (min gap ${runtimeMinGapMs}ms, scorecard every ${runtimeScorecardEveryN},`
    + ` host ${C.host}, session #${activeSessionId})`
  );
}

function stopPollerTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Restart the interval timer if a session is active (after settings change). */
function restartPollerIfRunning() {
  if (!timer) return;
  stopPollerTimer();
  ensurePollerRunning();
}

function scheduleExpiry(endsAt) {
  clearExpiryTimer();
  const endsMs = endsAt instanceof Date ? endsAt.getTime() : new Date(endsAt).getTime();
  const wait = Math.max(0, endsMs - Date.now());
  expiryTimer = setTimeout(() => {
    expireActiveSession().catch((e) => console.error('[rapidapi] expire:', e.message));
  }, wait);
}

function mapSessionRow(row) {
  if (!row) return null;
  const endsAt = row.ends_at instanceof Date ? row.ends_at : new Date(row.ends_at);
  const startedAt = row.started_at instanceof Date ? row.started_at : new Date(row.started_at);
  const remainingSeconds = row.status === 'ACTIVE'
    ? Math.max(0, Math.floor((endsAt.getTime() - Date.now()) / 1000))
    : 0;
  return {
    id: row.id,
    durationMinutes: row.duration_minutes,
    startedAt: startedAt.toISOString(),
    endsAt: endsAt.toISOString(),
    stoppedAt: row.stopped_at
      ? (row.stopped_at instanceof Date ? row.stopped_at : new Date(row.stopped_at)).toISOString()
      : null,
    status: row.status,
    apiCalls: row.api_calls,
    startedBy: row.started_by,
    remainingSeconds,
  };
}

async function expireStaleSessions() {
  await pool.query(
    `UPDATE rapidapi_poll_sessions
        SET status = 'EXPIRED', stopped_at = UTC_TIMESTAMP()
      WHERE status = 'ACTIVE' AND ends_at <= UTC_TIMESTAMP()`
  );
}

async function expireActiveSession() {
  clearExpiryTimer();
  stopPollerTimer();
  const id = activeSessionId;
  activeSessionId = null;
  if (id) {
    await pool.query(
      `UPDATE rapidapi_poll_sessions
          SET status = 'EXPIRED', stopped_at = UTC_TIMESTAMP()
        WHERE id = ? AND status = 'ACTIVE'`,
      [id]
    );
    console.log(`[rapidapi] poll session #${id} expired`);
  } else {
    await expireStaleSessions();
  }
}

async function resumeActiveSessionIfAny() {
  await expireStaleSessions();
  const [[row]] = await pool.query(
    `SELECT * FROM rapidapi_poll_sessions
      WHERE status = 'ACTIVE' AND ends_at > UTC_TIMESTAMP()
      ORDER BY id DESC LIMIT 1`
  );
  if (!row) {
    activeSessionId = null;
    stopPollerTimer();
    clearExpiryTimer();
    console.log('[rapidapi] no active poll session — enable from Admin console (15m / 1h / 2h)');
    return null;
  }
  activeSessionId = row.id;
  ensurePollerRunning();
  scheduleExpiry(row.ends_at);
  console.log(
    `[rapidapi] resumed poll session #${row.id} until ${new Date(row.ends_at).toISOString()}`
    + ` (${row.api_calls} API calls so far)`
  );
  return row;
}

/**
 * Start a timed auto-poll window (15 | 60 | 120 minutes).
 * Replaces any currently ACTIVE session.
 */
async function startPollSession(durationMinutes, startedBy = null) {
  if (!C.key) throw new AppError(400, 'NO_KEY', 'RAPIDAPI_KEY not configured');
  const mins = Number(durationMinutes);
  if (!ALLOWED_POLL_MINUTES.has(mins)) {
    throw new AppError(400, 'BAD_DURATION', 'durationMinutes must be 15, 60, or 120');
  }

  // Close any prior active session(s).
  await pool.query(
    `UPDATE rapidapi_poll_sessions
        SET status = 'STOPPED', stopped_at = UTC_TIMESTAMP()
      WHERE status = 'ACTIVE'`
  );
  stopPollerTimer();
  clearExpiryTimer();
  activeSessionId = null;

  const [ins] = await pool.query(
    `INSERT INTO rapidapi_poll_sessions
       (duration_minutes, started_at, ends_at, status, api_calls, started_by)
     VALUES (?, UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), 'ACTIVE', 0, ?)`,
    [mins, mins, startedBy]
  );
  activeSessionId = ins.insertId;
  ensurePollerRunning();

  const [[row]] = await pool.query('SELECT * FROM rapidapi_poll_sessions WHERE id = ?', [activeSessionId]);
  scheduleExpiry(row.ends_at);
  // Kick one tick immediately so LIVE matches update without waiting a full interval.
  tickOnce().catch((e) => console.error('[rapidapi]', e.message));

  return getPollStatus();
}

async function stopPollSession() {
  clearExpiryTimer();
  stopPollerTimer();
  const id = activeSessionId;
  activeSessionId = null;
  if (id) {
    await pool.query(
      `UPDATE rapidapi_poll_sessions
          SET status = 'STOPPED', stopped_at = UTC_TIMESTAMP()
        WHERE id = ? AND status = 'ACTIVE'`,
      [id]
    );
  } else {
    await pool.query(
      `UPDATE rapidapi_poll_sessions
          SET status = 'STOPPED', stopped_at = UTC_TIMESTAMP()
        WHERE status = 'ACTIVE'`
    );
  }
  return getPollStatus();
}

async function getPollStatus() {
  await expireStaleSessions();
  if (activeSessionId) {
    const [[cur]] = await pool.query(
      'SELECT * FROM rapidapi_poll_sessions WHERE id = ?',
      [activeSessionId]
    );
    if (!cur || cur.status !== 'ACTIVE' || new Date(cur.ends_at).getTime() <= Date.now()) {
      await expireActiveSession();
    }
  } else {
    const [[live]] = await pool.query(
      `SELECT * FROM rapidapi_poll_sessions
        WHERE status = 'ACTIVE' AND ends_at > UTC_TIMESTAMP()
        ORDER BY id DESC LIMIT 1`
    );
    if (live) {
      activeSessionId = live.id;
      ensurePollerRunning();
      scheduleExpiry(live.ends_at);
    }
  }

  let session = null;
  if (activeSessionId) {
    const [[row]] = await pool.query(
      'SELECT * FROM rapidapi_poll_sessions WHERE id = ?',
      [activeSessionId]
    );
    session = mapSessionRow(row);
  }

  const [recent] = await pool.query(
    `SELECT * FROM rapidapi_poll_sessions
      ORDER BY id DESC LIMIT 10`
  );

  const settings = await appSettings.getRapidApiSettings();
  return {
    active: !!(session && session.status === 'ACTIVE' && session.remainingSeconds > 0),
    pollLiveMs: settings.pollLiveMs,
    minGapMs: settings.minGapMs,
    scorecardEveryN: settings.scorecardEveryN,
    syncFixtureLimit: settings.syncFixtureLimit,
    allowedPollLiveMs: settings.allowedPollLiveMs,
    allowedDurations: [15, 60, 120],
    session,
    recent: recent.map(mapSessionRow),
  };
}

async function getSettings() {
  return appSettings.getRapidApiSettings();
}

async function updateSettings(body) {
  const settings = await appSettings.updateRapidApiSettings(body);
  await refreshRuntimeSettings();
  restartPollerIfRunning();
  return settings;
}

/**
 * RapidAPI call analytics for admin UI.
 * @param {{ limit?: number, offset?: number }} opts
 */
async function getCallAnalytics({ limit = 100, offset = 0 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);

  const [[totals]] = await pool.query(
    `SELECT
        COUNT(*) AS totalCalls,
        SUM(ok = 1) AS okCalls,
        SUM(ok = 0) AS errorCalls,
        SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR) AS calls24h,
        SUM(created_at >= UTC_DATE()) AS callsToday,
        ROUND(AVG(duration_ms)) AS avgDurationMs
      FROM rapidapi_call_log`
  );

  const [byKind] = await pool.query(
    `SELECT endpoint_kind AS kind, COUNT(*) AS count
       FROM rapidapi_call_log
      GROUP BY endpoint_kind
      ORDER BY count DESC`
  );

  const [[countRow]] = await pool.query('SELECT COUNT(*) AS c FROM rapidapi_call_log');
  const [rows] = await pool.query(
    `SELECT id, path, endpoint_kind, http_status, ok, duration_ms, session_id, error_message, created_at
       FROM rapidapi_call_log
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    [lim, off]
  );

  return {
    summary: {
      totalCalls: Number(totals?.totalCalls || 0),
      okCalls: Number(totals?.okCalls || 0),
      errorCalls: Number(totals?.errorCalls || 0),
      calls24h: Number(totals?.calls24h || 0),
      callsToday: Number(totals?.callsToday || 0),
      avgDurationMs: Number(totals?.avgDurationMs || 0),
      byKind: byKind.map((r) => ({ kind: r.kind, count: Number(r.count) })),
    },
    total: Number(countRow?.c || 0),
    limit: lim,
    offset: off,
    calls: rows.map((r) => ({
      id: r.id,
      path: r.path,
      endpointKind: r.endpoint_kind,
      httpStatus: r.http_status,
      ok: !!r.ok,
      durationMs: r.duration_ms,
      sessionId: r.session_id,
      errorMessage: r.error_message,
      createdAt: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
    })),
  };
}

/** Boot hook — resume timed session if one is still ACTIVE; never env-auto-start. */
async function start() {
  if (!C.key) {
    console.warn('[rapidapi] RAPIDAPI_KEY missing — poller not started');
    return;
  }
  try {
    await refreshRuntimeSettings();
  } catch (e) {
    console.warn(`[rapidapi] settings load skipped: ${e.message}`);
  }
  try {
    await resumeActiveSessionIfAny();
  } catch (e) {
    // Table may not exist until migration 007 is applied.
    console.warn(`[rapidapi] poll session resume skipped: ${e.message}`);
  }
}

function stop() {
  clearExpiryTimer();
  stopPollerTimer();
}

module.exports = {
  start, stop, tickOnce, syncFixtures, syncFixturesAdmin, syncStatuses, syncMatch, clearMatches,
  startPollSession, stopPollSession, getPollStatus, getCallAnalytics,
  getSettings, updateSettings,
  extractFixtures, extractLive, extractDeliveries, extractScorecard, mapStatus,
};
