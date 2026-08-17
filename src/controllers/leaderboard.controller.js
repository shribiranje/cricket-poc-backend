const pool = require('../config/db');
const { ok } = require('../utils/response');

/**
 * GET /api/matches/:id/leaderboard
 * Returns all user_teams for a match, ranked by points desc.
 */
exports.forMatch = async (req, res, next) => {
  try {
    const matchId = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT ut.id AS user_team_id, ut.user_id, u.username, u.display_name, u.avatar_url,
              ut.total_points, ut.total_credits_used, ut.is_locked
         FROM user_teams ut
         JOIN users u ON u.id = ut.user_id
        WHERE ut.match_id = ?
        ORDER BY ut.total_points DESC, ut.id ASC`,
      [matchId]
    );
    const leaderboard = rows.map((r, i) => ({
      rank: i + 1,
      userTeamId: r.user_team_id,
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      totalPoints: Number(r.total_points),
      totalCreditsUsed: Number(r.total_credits_used),
    }));
    return ok(res, leaderboard);
  } catch (e) { next(e); }
};
