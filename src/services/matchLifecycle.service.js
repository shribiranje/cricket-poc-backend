/**
 * Match lifecycle — the single source of truth for state transitions.
 *
 * Used by:
 *   - admin routes ("Start match" / "Complete match" buttons)
 *   - scheduler.service (auto-start at scheduled time)
 *   - matchEngine.service (auto-complete when innings 2 ends naturally)
 *
 * Keeping this in one place guarantees manual and automatic paths behave
 * identically (locking user teams, seeding stat rows, recalcing points).
 */
const pool = require('../config/db');
const { AppError } = require('../utils/response');
const { recalcAllForMatch } = require('./userTeamScore.service');

/**
 * UPCOMING → LIVE. Locks user teams, seeds player_match_stats, and
 * initializes the ball-aware engine state for non-external matches.
 * Race-safe: the conditional UPDATE means only one caller wins.
 */
async function startMatch(matchId) {
  const [r] = await pool.query(
    `UPDATE matches SET status = 'LIVE' WHERE id = ? AND status = 'UPCOMING'`,
    [matchId]
  );
  if (!r.affectedRows) {
    throw new AppError(400, 'CANNOT_START', 'Match cannot be started (not UPCOMING)');
  }

  await pool.query('UPDATE user_teams SET is_locked = 1 WHERE match_id = ?', [matchId]);
  await pool.query(
    `INSERT IGNORE INTO player_match_stats (match_id, player_id)
       SELECT match_id, player_id FROM match_players WHERE match_id = ?`,
    [matchId]
  );

  // Initialize innings state for simulator/manual matches only.
  // Sportmonks fixtures are driven by the external feed instead.
  const [[m]] = await pool.query('SELECT external_id FROM matches WHERE id = ?', [matchId]);
  if (m && m.external_id == null) {
    // Lazy require avoids a circular dependency (engine requires lifecycle).
    const engine = require('./matchEngine.service');
    try {
      await engine.initState(matchId);
    } catch (e) {
      // Don't leave the match half-started because the squad is malformed —
      // the engine will retry lazily on the first ball; just log here.
      console.error(`[lifecycle] engine init for match ${matchId} deferred:`, e.message);
    }
  }

  return { id: matchId, status: 'LIVE' };
}

/** LIVE → COMPLETED. Final recalc of every user team for the match. */
async function completeMatch(matchId) {
  const [r] = await pool.query(
    `UPDATE matches SET status = 'COMPLETED' WHERE id = ? AND status = 'LIVE'`,
    [matchId]
  );
  if (!r.affectedRows) {
    throw new AppError(400, 'CANNOT_COMPLETE', 'Match cannot be completed (not LIVE)');
  }
  await recalcAllForMatch(matchId);

  // Void + refund any prediction whose ball/over never got bowled.
  // Lazy require keeps lifecycle free of a hard prediction dependency.
  try {
    await require('./prediction.service').voidOpenForMatch(matchId);
  } catch (e) {
    console.error(`[lifecycle] prediction void failed for match ${matchId}:`, e.message);
  }

  return { id: matchId, status: 'COMPLETED' };
}

module.exports = { startMatch, completeMatch };
