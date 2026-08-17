/**
 * Sportmonks Cricket API poller.
 * ------------------------------
 * Drop-in replacement for simulator.service.js. Same contract:
 *   start() / stop() / tickOnce()
 *
 * smFetch() includes retry-with-backoff for rate-limit errors ("Too Many Attempts").
 */
const pool = require('../config/db');
const config = require('../config');
const { calcPoints } = require('./scoring.service');
const { recalcAllForMatch } = require('./userTeamScore.service');

const INCLUDES = 'batting,bowling,runs,lineup,localteam,visitorteam';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with retry + exponential backoff on rate limits.
 * @param {string} path e.g. '/fixtures/12345'
 * @param {object} query key/value pairs; api_token is added automatically
 * @param {object} opts { maxRetries=3, retryBaseMs=5000 }
 */
async function smFetch(path, query = {}, opts = {}) {
  if (!config.sportmonks.apiToken) {
    throw new Error('SPORTMONKS_API_TOKEN not configured');
  }
  const maxRetries = opts.maxRetries ?? 3;
  const retryBaseMs = opts.retryBaseMs ?? 5000;

  const url = new URL(`${config.sportmonks.baseUrl}${path}`);
  url.searchParams.set('api_token', config.sportmonks.apiToken);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) return res.json();

      const bodyText = await res.text().catch(() => '');
      const isRateLimit =
        res.status === 429 ||
        /too many attempts|rate.?limit/i.test(bodyText);

      if (isRateLimit && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : retryBaseMs * Math.pow(2, attempt);
        console.warn(`[sportmonks] rate limited on ${path}; sleeping ${Math.round(waitMs/1000)}s (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }

      throw new Error(`Sportmonks ${res.status} for ${path}: ${bodyText.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries && /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(String(e.message))) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error(`Sportmonks ${path} failed after ${maxRetries} retries`);
}

function mapStatus(smStatus) {
  if (!smStatus) return 'UPCOMING';
  const s = String(smStatus);
  if (s === 'NS') return 'UPCOMING';
  if (/Finished|Aban|Postp|Cancl|Awarded/i.test(s)) return 'COMPLETED';
  return 'LIVE';
}

async function getLiveOrJustStartedMatches() {
  const [rows] = await pool.query(
    `SELECT id, external_id, status
       FROM matches
      WHERE external_id IS NOT NULL
        AND status IN ('LIVE', 'UPCOMING')
        AND (status = 'LIVE' OR start_time <= DATE_ADD(NOW(), INTERVAL 15 MINUTE))`
  );
  return rows;
}

async function getInternalPlayerId(externalId) {
  if (!externalId) return null;
  const [[row]] = await pool.query('SELECT id FROM players WHERE external_id = ?', [externalId]);
  return row?.id || null;
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

async function ingestFixture(matchId, fixture) {
  const mapped = mapStatus(fixture.status);
  if (mapped === 'LIVE') await transitionToLive(matchId, fixture.status);
  else if (mapped === 'COMPLETED') {
    await transitionToLive(matchId, fixture.status);
    await transitionToCompleted(matchId, fixture.status);
  } else return;

  const batting = fixture.batting || [];
  for (const b of batting) {
    const pid = await getInternalPlayerId(b.player_id);
    if (!pid) continue;
    await pool.query(
      `INSERT INTO player_match_stats (match_id, player_id, runs, balls_faced, fours, sixes)
         VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         runs = VALUES(runs), balls_faced = VALUES(balls_faced),
         fours = VALUES(fours), sixes = VALUES(sixes)`,
      [matchId, pid, +b.score || 0, +b.ball || 0, +b.four_x || 0, +b.six_x || 0]
    );
  }

  const bowling = fixture.bowling || [];
  for (const b of bowling) {
    const pid = await getInternalPlayerId(b.player_id);
    if (!pid) continue;
    const balls_bowled = oversToBalls(b.overs);
    await pool.query(
      `INSERT INTO player_match_stats
         (match_id, player_id, balls_bowled, runs_conceded, wickets)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         balls_bowled = VALUES(balls_bowled),
         runs_conceded = VALUES(runs_conceded),
         wickets = VALUES(wickets)`,
      [matchId, pid, balls_bowled, +b.runs || 0, +b.wickets || 0]
    );
  }

  await recountCatches(matchId, batting);

  const [statRows] = await pool.query(
    `SELECT * FROM player_match_stats WHERE match_id = ?`, [matchId]
  );
  for (const s of statRows) {
    const pts = calcPoints(s);
    await pool.query(
      `UPDATE player_match_stats SET points = ? WHERE match_id = ? AND player_id = ?`,
      [pts, matchId, s.player_id]
    );
  }

  await recalcAllForMatch(matchId);
}

async function recountCatches(matchId, batting) {
  await pool.query(`UPDATE player_match_stats SET catches = 0 WHERE match_id = ?`, [matchId]);
  for (const b of batting) {
    const fielderPid = await getInternalPlayerId(b.catch_stump_player_id);
    if (fielderPid) {
      await pool.query(
        `INSERT INTO player_match_stats (match_id, player_id, catches)
           VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE catches = catches + 1`,
        [matchId, fielderPid]
      );
    }
  }
}

function oversToBalls(overs) {
  const n = Number(overs) || 0;
  const wholeOvers = Math.floor(n);
  const balls = Math.round((n - wholeOvers) * 10);
  return wholeOvers * 6 + balls;
}

async function tickOnce() {
  const matches = await getLiveOrJustStartedMatches();
  for (const m of matches) {
    try {
      const res = await smFetch(`/fixtures/${m.external_id}`, { include: INCLUDES });
      const fixture = res.data;
      if (!fixture) continue;
      await ingestFixture(m.id, fixture);
    } catch (e) {
      console.error(`[sportmonks] fixture ${m.external_id} failed:`, e.message);
    }
  }
}

let timer = null;

function start() {
  if (config.dataSource !== 'SPORTMONKS') {
    console.log('[sportmonks] not the active data source, skipping start');
    return;
  }
  if (!config.sportmonks.apiToken) {
    console.warn('[sportmonks] SPORTMONKS_API_TOKEN not set — poller will fail; edit .env');
    return;
  }
  if (timer) return;
  console.log(`[sportmonks] starting poller every ${config.sportmonks.pollLiveMs}ms`);
  const loop = async () => {
    try { await tickOnce(); }
    catch (e) { console.error('[sportmonks] tick error', e); }
  };
  loop();
  timer = setInterval(loop, config.sportmonks.pollLiveMs);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tickOnce, smFetch, oversToBalls, mapStatus, sleep };
