const pool = require('../config/db');
const config = require('../config');

/**
 * Recalculate total_points for every user_team in a given match, applying
 * captain / vice-captain multipliers, and persist to user_teams.total_points.
 */
async function recalcAllForMatch(matchId) {
  const [rows] = await pool.query(
    `SELECT ut.id AS user_team_id,
            ut.captain_player_id,
            ut.vice_captain_player_id,
            utp.player_id,
            COALESCE(pms.points, 0) AS points
       FROM user_teams ut
       JOIN user_team_players utp ON utp.user_team_id = ut.id
  LEFT JOIN player_match_stats pms
         ON pms.match_id = ut.match_id AND pms.player_id = utp.player_id
      WHERE ut.match_id = ?`,
    [matchId]
  );

  const totals = new Map();
  for (const r of rows) {
    let pts = Number(r.points);
    if (r.player_id === r.captain_player_id) pts *= config.rules.captainMultiplier;
    else if (r.player_id === r.vice_captain_player_id) pts *= config.rules.viceCaptainMultiplier;
    totals.set(r.user_team_id, (totals.get(r.user_team_id) || 0) + pts);
  }

  // Persist in a single transaction
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [utId, total] of totals) {
      await conn.query('UPDATE user_teams SET total_points = ? WHERE id = ?', [
        Math.round(total * 100) / 100,
        utId,
      ]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { recalcAllForMatch };
