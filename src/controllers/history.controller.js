const pool = require('../config/db');
const { ok } = require('../utils/response');
const { toIsoUtc } = require('../utils/datetime');

/**
 * GET /api/history
 * List past matches user has entered (LIVE + COMPLETED), with rank and points.
 */
exports.list = async (req, res, next) => {
  try {
    const userId = req.userId;
    const [rows] = await pool.query(
      `SELECT ut.id AS user_team_id, ut.total_points, ut.total_credits_used,
              m.id AS match_id, m.format, m.venue, m.start_time, m.status,
              ta.short_name AS team_a_short, tb.short_name AS team_b_short,
              (SELECT COUNT(*)+1 FROM user_teams ut2
                 WHERE ut2.match_id = ut.match_id AND ut2.total_points > ut.total_points) AS rank_pos,
              (SELECT COUNT(*) FROM user_teams ut3 WHERE ut3.match_id = ut.match_id) AS total_entries
         FROM user_teams ut
         JOIN matches m ON m.id = ut.match_id
         JOIN teams ta  ON ta.id = m.team_a_id
         JOIN teams tb  ON tb.id = m.team_b_id
        WHERE ut.user_id = ?
        ORDER BY m.start_time DESC`,
      [userId]
    );
    return ok(res, rows.map((r) => ({
      userTeamId: r.user_team_id,
      match: {
        id: r.match_id,
        format: r.format,
        venue: r.venue,
        startTime: toIsoUtc(r.start_time),
        status: r.status,
        teamAShort: r.team_a_short,
        teamBShort: r.team_b_short,
      },
      totalPoints: Number(r.total_points),
      totalCreditsUsed: Number(r.total_credits_used),
      rank: Number(r.rank_pos),
      totalEntries: Number(r.total_entries),
    })));
  } catch (e) { next(e); }
};
