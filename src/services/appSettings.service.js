/**
 * Persistent key/value settings (admin-editable).
 * Env/config remains the fallback when a key is missing.
 */
const pool = require('../config/db');
const config = require('../config');
const { AppError } = require('../utils/response');

const KEYS = {
  POLL_LIVE_MS: 'rapidapi.poll_live_ms',
  MIN_GAP_MS: 'rapidapi.min_gap_ms',
  SCORECARD_EVERY_N: 'rapidapi.scorecard_every_n',
  SYNC_FIXTURE_LIMIT: 'rapidapi.sync_fixture_limit',
};

/** Allowed poll intervals (ms) — 1 / 2 / 5 minutes. */
const ALLOWED_POLL_LIVE_MS = new Set([60000, 120000, 300000]);

const DEFAULTS = {
  [KEYS.POLL_LIVE_MS]: config.rapidapi.pollLiveMs || 120000,
  [KEYS.MIN_GAP_MS]: config.rapidapi.minGapMs || 2500,
  [KEYS.SCORECARD_EVERY_N]: 4,
  [KEYS.SYNC_FIXTURE_LIMIT]: 20,
};

/** In-memory cache; refreshed on load/update. */
let cache = { ...DEFAULTS };
let loaded = false;

function asInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function ensureLoaded() {
  if (loaded) return;
  await reload();
}

async function reload() {
  try {
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value FROM app_settings
        WHERE setting_key IN (?, ?, ?, ?)`,
      [KEYS.POLL_LIVE_MS, KEYS.MIN_GAP_MS, KEYS.SCORECARD_EVERY_N, KEYS.SYNC_FIXTURE_LIMIT]
    );
    const next = { ...DEFAULTS };
    for (const r of rows) {
      next[r.setting_key] = asInt(r.setting_value, DEFAULTS[r.setting_key]);
    }
    cache = next;
    loaded = true;
  } catch (e) {
    // Table may not exist until migration 010 — fall back to env defaults.
    console.warn(`[app_settings] load skipped: ${e.message}`);
    cache = { ...DEFAULTS };
    loaded = true;
  }
}

async function get(key) {
  await ensureLoaded();
  return cache[key] ?? DEFAULTS[key];
}

async function setMany(updates) {
  const entries = Object.entries(updates);
  if (!entries.length) return getRapidApiSettings();

  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO app_settings (setting_key, setting_value)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, String(value)]
    );
    cache[key] = asInt(value, DEFAULTS[key]);
  }
  loaded = true;
  return getRapidApiSettings();
}

function validateRapidApiPatch(body = {}) {
  const patch = {};

  if (body.pollLiveMs != null) {
    const ms = Number(body.pollLiveMs);
    if (!ALLOWED_POLL_LIVE_MS.has(ms)) {
      throw new AppError(400, 'BAD_POLL_INTERVAL',
        'pollLiveMs must be 60000, 120000, or 300000 (1 / 2 / 5 min)');
    }
    patch[KEYS.POLL_LIVE_MS] = ms;
  }

  if (body.minGapMs != null) {
    const ms = Number(body.minGapMs);
    if (!Number.isFinite(ms) || ms < 0 || ms > 30000) {
      throw new AppError(400, 'BAD_MIN_GAP', 'minGapMs must be 0–30000');
    }
    patch[KEYS.MIN_GAP_MS] = Math.round(ms);
  }

  if (body.scorecardEveryN != null) {
    const n = Number(body.scorecardEveryN);
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      throw new AppError(400, 'BAD_SCORECARD_N', 'scorecardEveryN must be 1–20');
    }
    patch[KEYS.SCORECARD_EVERY_N] = n;
  }

  if (body.syncFixtureLimit != null) {
    const n = Number(body.syncFixtureLimit);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      throw new AppError(400, 'BAD_SYNC_LIMIT', 'syncFixtureLimit must be 1–50');
    }
    patch[KEYS.SYNC_FIXTURE_LIMIT] = n;
  }

  if (!Object.keys(patch).length) {
    throw new AppError(400, 'EMPTY_PATCH', 'Provide at least one setting to update');
  }
  return patch;
}

async function getRapidApiSettings() {
  await ensureLoaded();
  return {
    pollLiveMs: cache[KEYS.POLL_LIVE_MS],
    minGapMs: cache[KEYS.MIN_GAP_MS],
    scorecardEveryN: cache[KEYS.SCORECARD_EVERY_N],
    syncFixtureLimit: cache[KEYS.SYNC_FIXTURE_LIMIT],
    allowedPollLiveMs: [...ALLOWED_POLL_LIVE_MS].sort((a, b) => a - b),
  };
}

async function updateRapidApiSettings(body) {
  const patch = validateRapidApiPatch(body);
  return setMany(patch);
}

/** Sync getters used by the poller (cached after first load). */
async function getPollLiveMs() {
  return get(KEYS.POLL_LIVE_MS);
}

async function getMinGapMs() {
  return get(KEYS.MIN_GAP_MS);
}

async function getScorecardEveryN() {
  return get(KEYS.SCORECARD_EVERY_N);
}

async function getSyncFixtureLimit() {
  return get(KEYS.SYNC_FIXTURE_LIMIT);
}

module.exports = {
  KEYS,
  ALLOWED_POLL_LIVE_MS,
  reload,
  getRapidApiSettings,
  updateRapidApiSettings,
  getPollLiveMs,
  getMinGapMs,
  getScorecardEveryN,
  getSyncFixtureLimit,
};
