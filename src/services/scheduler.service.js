/**
 * Auto-start scheduler
 * --------------------
 * Every AUTO_START_POLL_MS it looks for UPCOMING matches whose start_time
 * (stored in UTC) has passed and flips them LIVE through the exact same
 * lifecycle path the admin "Start match" button uses.
 *
 * Scope: manual / simulator matches only (external_id IS NULL). Sportmonks
 * fixtures are promoted by the real feed's status instead, which correctly
 * handles delays and rain.
 *
 * Matches created with auto_start = 0 are ignored and must be started by hand.
 */
const pool = require('../config/db');
const config = require('../config');
const lifecycle = require('./matchLifecycle.service');

let timer = null;

async function tickOnce() {
  const [rows] = await pool.query(
    `SELECT id FROM matches
      WHERE status = 'UPCOMING'
        AND auto_start = 1
        AND external_id IS NULL
        AND start_time <= UTC_TIMESTAMP()`
  );
  for (const r of rows) {
    try {
      await lifecycle.startMatch(r.id);
      console.log(`[scheduler] auto-started match ${r.id}`);
    } catch (e) {
      // CANNOT_START just means someone beat us to it — a benign race.
      if (e.code !== 'CANNOT_START') {
        console.error(`[scheduler] failed to auto-start match ${r.id}:`, e.message);
      }
    }
  }
}

function start() {
  if (!config.scheduler.enabled) {
    console.log('[scheduler] disabled by config (AUTO_START_ENABLED=false)');
    return;
  }
  if (timer) return;
  console.log(`[scheduler] auto-start polling every ${config.scheduler.pollMs}ms`);
  timer = setInterval(() => {
    tickOnce().catch((e) => console.error('[scheduler] tick error', e.message));
  }, config.scheduler.pollMs);
  // Fire once immediately so restarts pick up overdue matches without waiting.
  tickOnce().catch((e) => console.error('[scheduler] tick error', e.message));
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tickOnce };
