const pool = require('../config/db');
const { ok, AppError } = require('../utils/response');
const { toIsoUtc } = require('../utils/datetime');
const { oversForFormat } = require('../services/matchEngine.service');

const fmtOvers = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;

exports.list = async (req, res, next) => {
  try {
    const status = req.query.status; // optional filter
    const params = [];
    let where = '';
    if (status) { where = 'WHERE m.status = ?'; params.push(status.toUpperCase()); }
    const [rows] = await pool.query(
      `SELECT m.id, m.format, m.venue, m.start_time, m.timezone, m.status, m.external_id,
              ta.id AS team_a_id, ta.name AS team_a_name, ta.short_name AS team_a_short,
              tb.id AS team_b_id, tb.name AS team_b_name, tb.short_name AS team_b_short,
              ms.innings AS st_innings, ms.runs AS st_runs, ms.wickets AS st_wickets,
              ms.legal_balls AS st_balls, ms.target AS st_target,
              ms.finished AS st_finished, ms.result AS st_result,
              bt.short_name AS st_batting_short
         FROM matches m
         JOIN teams ta ON ta.id = m.team_a_id
         JOIN teams tb ON tb.id = m.team_b_id
    LEFT JOIN match_state ms ON ms.match_id = m.id
    LEFT JOIN teams bt ON bt.id = ms.batting_team_id
         ${where}
         ORDER BY m.start_time ASC`,
      params
    );
    return ok(res, rows.map(shape));
  } catch (e) { next(e); }
};

exports.detail = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT m.id, m.format, m.venue, m.start_time, m.timezone, m.status, m.external_id,
              ta.id AS team_a_id, ta.name AS team_a_name, ta.short_name AS team_a_short,
              tb.id AS team_b_id, tb.name AS team_b_name, tb.short_name AS team_b_short,
              ms.innings AS st_innings, ms.runs AS st_runs, ms.wickets AS st_wickets,
              ms.legal_balls AS st_balls, ms.target AS st_target,
              ms.finished AS st_finished, ms.result AS st_result,
              bt.short_name AS st_batting_short
         FROM matches m
         JOIN teams ta ON ta.id = m.team_a_id
         JOIN teams tb ON tb.id = m.team_b_id
    LEFT JOIN match_state ms ON ms.match_id = m.id
    LEFT JOIN teams bt ON bt.id = ms.batting_team_id
        WHERE m.id = ?`,
      [id]
    );
    if (!rows.length) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
    return ok(res, shape(rows[0]));
  } catch (e) { next(e); }
};

exports.players = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.role, p.credit,
              t.id AS team_id, t.short_name AS team_short,
              COALESCE(s.points, 0) AS current_points
         FROM match_players mp
         JOIN players p ON p.id = mp.player_id
         JOIN teams t ON t.id = p.team_id
    LEFT JOIN player_match_stats s ON s.match_id = mp.match_id AND s.player_id = p.id
        WHERE mp.match_id = ?
        ORDER BY p.role, p.credit DESC`,
      [id]
    );
    return ok(res, rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      credit: Number(r.credit),
      teamId: r.team_id,
      teamShort: r.team_short,
      currentPoints: Number(r.current_points),
    })));
  } catch (e) { next(e); }
};

function shape(r) {
  return {
    id: r.id,
    format: r.format,
    venue: r.venue,
    startTime: toIsoUtc(r.start_time),
    timezone: r.timezone,
    status: r.status,
    isExternal: r.external_id != null,
    teamA: { id: r.team_a_id, name: r.team_a_name, short: r.team_a_short },
    teamB: { id: r.team_b_id, name: r.team_b_name, short: r.team_b_short },
    // Compact engine state so list cards can show a live score / final result
    // without an extra request per match. Null for fixtures never started.
    state: r.st_innings == null ? null : {
      innings: r.st_innings,
      battingShort: r.st_batting_short,
      runs: r.st_runs,
      wickets: r.st_wickets,
      overs: fmtOvers(r.st_balls),
      target: r.st_target,
      finished: !!r.st_finished,
      result: r.st_result,
    },
  };
}

/**
 * GET /api/matches/:id/state — live scoreboard from the ball-aware engine.
 * Returns null data for matches with no engine state (e.g. Sportmonks fixtures
 * or matches that never went LIVE).
 */
exports.state = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT ms.*, m.format,
              bt.id AS bat_id, bt.short_name AS bat_short, bt.name AS bat_name,
              bw.short_name AS bowl_short,
              ps.name AS striker_name, pn.name AS non_striker_name, pb.name AS bowler_name
         FROM match_state ms
         JOIN matches m ON m.id = ms.match_id
         JOIN teams bt ON bt.id = ms.batting_team_id
         JOIN teams bw ON bw.id = ms.bowling_team_id
    LEFT JOIN players ps ON ps.id = ms.striker_id
    LEFT JOIN players pn ON pn.id = ms.non_striker_id
    LEFT JOIN players pb ON pb.id = ms.bowler_id
        WHERE ms.match_id = ?`,
      [id]
    );
    if (!rows.length) return ok(res, null);
    const s = rows[0];
    return ok(res, {
      innings: s.innings,
      battingTeam: { id: s.bat_id, short: s.bat_short, name: s.bat_name },
      bowlingTeamShort: s.bowl_short,
      runs: s.runs,
      wickets: s.wickets,
      overs: fmtOvers(s.legal_balls),
      totalOvers: oversForFormat(s.format),
      target: s.target,
      innings1: s.innings1_runs == null ? null : {
        runs: s.innings1_runs,
        wickets: s.innings1_wickets,
        overs: fmtOvers(s.innings1_balls),
      },
      striker: s.striker_name,
      nonStriker: s.non_striker_name,
      bowler: s.bowler_name,
      finished: !!s.finished,
      result: s.result,
    });
  } catch (e) { next(e); }
};
