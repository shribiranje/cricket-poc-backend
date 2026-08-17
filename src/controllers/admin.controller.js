const pool = require('../config/db');
const { ok, AppError } = require('../utils/response');
const { recalcAllForMatch } = require('../services/userTeamScore.service');
const { toMysqlUtc, toIsoUtc } = require('../utils/datetime');
const { hash } = require('../utils/password');

const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/; // loose IANA tz name check (e.g. Asia/Kolkata)
const fmtOvers = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;

/** GET /api/admin/stats */
exports.stats = async (req, res, next) => {
  try {
    const [[u]]  = await pool.query('SELECT COUNT(*) c FROM users');
    const [[a]]  = await pool.query('SELECT COUNT(*) c FROM users WHERE is_admin = 1');
    const [[t]]  = await pool.query('SELECT COUNT(*) c FROM user_teams');
    const [[p]]  = await pool.query('SELECT COUNT(*) c FROM players');
    const [[te]] = await pool.query('SELECT COUNT(*) c FROM teams');
    const [byStatus] = await pool.query(
      `SELECT status, COUNT(*) c FROM matches GROUP BY status`
    );
    const s = { UPCOMING: 0, LIVE: 0, COMPLETED: 0 };
    byStatus.forEach((r) => { s[r.status] = r.c; });

    return ok(res, {
      users: u.c,
      admins: a.c,
      teamsEntered: t.c,
      players: p.c,
      teams: te.c,
      matches: {
        upcoming:  s.UPCOMING,
        live:      s.LIVE,
        completed: s.COMPLETED,
        total: s.UPCOMING + s.LIVE + s.COMPLETED,
      },
    });
  } catch (e) { next(e); }
};

/** GET /api/admin/users */
exports.listUsers = async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_admin, u.created_at,
              (SELECT COUNT(*) FROM user_teams WHERE user_id = u.id) AS team_count
         FROM users u
         ORDER BY u.id`
    );
    return ok(res, rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      isAdmin: !!r.is_admin,
      joinDate: r.created_at,
      teamCount: Number(r.team_count),
    })));
  } catch (e) { next(e); }
};

/** PATCH /api/admin/users/:id/admin  body: { isAdmin: boolean } */
exports.setAdmin = async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const isAdmin = !!req.body.isAdmin;

    // Guard against demoting the very last admin
    if (!isAdmin) {
      const [[count]] = await pool.query('SELECT COUNT(*) c FROM users WHERE is_admin = 1');
      const [[target]] = await pool.query('SELECT is_admin FROM users WHERE id = ?', [targetId]);
      if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
      if (target.is_admin && count.c <= 1) {
        throw new AppError(400, 'LAST_ADMIN', 'Cannot demote the only remaining admin');
      }
    }
    // Self-demotion also blocked so a user can't accidentally lock themselves out
    if (!isAdmin && targetId === req.userId) {
      throw new AppError(400, 'CANNOT_DEMOTE_SELF', 'Use another admin account to demote yourself');
    }

    await pool.query('UPDATE users SET is_admin = ? WHERE id = ?', [isAdmin ? 1 : 0, targetId]);
    return ok(res, { id: targetId, isAdmin });
  } catch (e) { next(e); }
};

/** POST /api/admin/matches/:id/reset — wipe all live scoring for a match */
/**
 * Shared guard: block demoting the only remaining admin, or self-demotion
 * (so nobody can lock themselves out of the console).
 */
async function assertCanDemote(targetId, currentUserId) {
  const [[count]] = await pool.query('SELECT COUNT(*) c FROM users WHERE is_admin = 1');
  const [[target]] = await pool.query('SELECT is_admin FROM users WHERE id = ?', [targetId]);
  if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  if (target.is_admin && count.c <= 1) {
    throw new AppError(400, 'LAST_ADMIN', 'Cannot demote the only remaining admin');
  }
  if (targetId === currentUserId) {
    throw new AppError(400, 'CANNOT_DEMOTE_SELF', 'Use another admin account to demote yourself');
  }
}

/** POST /api/admin/users — create a user from the console (admin or regular). */
exports.createUser = async (req, res, next) => {
  try {
    const username = String(req.body.username).trim();
    const { password, displayName, avatarUrl } = req.body;

    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length) throw new AppError(409, 'USERNAME_TAKEN', 'Username already exists');

    const password_hash = await hash(password);
    const [r] = await pool.query(
      'INSERT INTO users (username, password_hash, display_name, avatar_url, is_admin) VALUES (?, ?, ?, ?, ?)',
      [username, password_hash, displayName?.trim() || username, avatarUrl || null, req.body.isAdmin ? 1 : 0]
    );
    return ok(res, { id: r.insertId, username, isAdmin: !!req.body.isAdmin }, 201);
  } catch (e) { next(e); }
};

/**
 * PATCH /api/admin/users/:id — edit an existing user.
 * Any subset of: username, displayName, avatarUrl, password (reset), isAdmin.
 */
exports.updateUser = async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const [[user]] = await pool.query('SELECT id, username, is_admin FROM users WHERE id = ?', [targetId]);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

    const sets = [];
    const params = [];

    if (req.body.username !== undefined) {
      const username = String(req.body.username).trim();
      if (username !== user.username) {
        const [clash] = await pool.query('SELECT id FROM users WHERE username = ? AND id <> ?', [username, targetId]);
        if (clash.length) throw new AppError(409, 'USERNAME_TAKEN', 'Username already exists');
        sets.push('username = ?'); params.push(username);
      }
    }
    if (req.body.displayName !== undefined) {
      sets.push('display_name = ?'); params.push(String(req.body.displayName).trim());
    }
    if (req.body.avatarUrl !== undefined) {
      sets.push('avatar_url = ?'); params.push(req.body.avatarUrl || null);
    }
    if (req.body.password) {
      sets.push('password_hash = ?'); params.push(await hash(req.body.password));
    }
    if (req.body.isAdmin !== undefined) {
      const isAdmin = !!req.body.isAdmin;
      if (!isAdmin && user.is_admin) await assertCanDemote(targetId, req.userId);
      sets.push('is_admin = ?'); params.push(isAdmin ? 1 : 0);
    }

    if (!sets.length) return ok(res, { id: targetId, updated: false });
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, targetId]);
    return ok(res, { id: targetId, updated: true });
  } catch (e) { next(e); }
};

exports.resetMatch = async (req, res, next) => {
  try {
    const matchId = Number(req.params.id);
    const [[match]] = await pool.query('SELECT id, status FROM matches WHERE id = ?', [matchId]);
    if (!match) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
    if (match.status === 'UPCOMING') {
      throw new AppError(400, 'NOT_STARTED', "Match hasn't started; nothing to reset");
    }

    await pool.query(
      `UPDATE player_match_stats
          SET runs=0, balls_faced=0, fours=0, sixes=0,
              wickets=0, balls_bowled=0, runs_conceded=0,
              catches=0, run_outs=0, stumpings=0, points=0
        WHERE match_id = ?`,
      [matchId]
    );
    await pool.query('DELETE FROM match_events WHERE match_id = ?', [matchId]);
    // Drop innings state — the engine re-tosses and starts a fresh innings 1
    // on the next ball if the match is still LIVE.
    await pool.query('DELETE FROM match_state WHERE match_id = ?', [matchId]);
    await recalcAllForMatch(matchId);
    return ok(res, { matchId, reset: true });
  } catch (e) { next(e); }
};

/** GET /api/admin/matches — richer match list w/ entry counts + live score, for the console */
exports.listMatches = async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, m.format, m.venue, m.start_time, m.timezone, m.auto_start,
              m.status, m.external_id,
              m.team_a_id, m.team_b_id,
              ta.short_name AS team_a_short, tb.short_name AS team_b_short,
              (SELECT COUNT(*) FROM user_teams WHERE match_id = m.id) AS entries,
              ms.innings AS st_innings, ms.runs AS st_runs, ms.wickets AS st_wickets,
              ms.legal_balls AS st_balls, ms.target AS st_target,
              ms.finished AS st_finished, ms.result AS st_result,
              bt.short_name AS st_batting_short
         FROM matches m
         JOIN teams ta ON ta.id = m.team_a_id
         JOIN teams tb ON tb.id = m.team_b_id
    LEFT JOIN match_state ms ON ms.match_id = m.id
    LEFT JOIN teams bt ON bt.id = ms.batting_team_id
         ORDER BY m.start_time DESC`
    );
    return ok(res, rows.map((r) => ({
      id: r.id,
      format: r.format,
      venue: r.venue,
      startTime: toIsoUtc(r.start_time),
      timezone: r.timezone,
      autoStart: !!r.auto_start,
      status: r.status,
      isExternal: r.external_id != null,
      teamAId: r.team_a_id,
      teamBId: r.team_b_id,
      teamAShort: r.team_a_short,
      teamBShort: r.team_b_short,
      entries: Number(r.entries),
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
    })));
  } catch (e) { next(e); }
};

/** GET /api/admin/teams — teams with squad sizes, for the match form dropdowns */
exports.listTeams = async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT t.id, t.name, t.short_name,
              (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS player_count
         FROM teams t
         ORDER BY t.name`
    );
    return ok(res, rows.map((r) => ({
      id: r.id,
      name: r.name,
      shortName: r.short_name,
      playerCount: Number(r.player_count),
    })));
  } catch (e) { next(e); }
};

/** Shared validation for create/update payloads. Returns normalized fields. */
async function validateMatchPayload(body, { requireAll }) {
  const out = {};

  if (requireAll || body.teamAId !== undefined || body.teamBId !== undefined) {
    const teamAId = Number(body.teamAId);
    const teamBId = Number(body.teamBId);
    if (!teamAId || !teamBId) throw new AppError(400, 'TEAMS_REQUIRED', 'teamAId and teamBId are required');
    if (teamAId === teamBId) throw new AppError(400, 'SAME_TEAM', 'A team cannot play itself');
    const [teams] = await pool.query(
      `SELECT t.id, (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS pc
         FROM teams t WHERE t.id IN (?, ?)`,
      [teamAId, teamBId]
    );
    if (teams.length !== 2) throw new AppError(404, 'TEAM_NOT_FOUND', 'One or both teams do not exist');
    const thin = teams.find((t) => Number(t.pc) < 2);
    if (thin) throw new AppError(400, 'SQUAD_TOO_SMALL', `Team ${thin.id} has fewer than 2 players — add players first`);
    out.teamAId = teamAId;
    out.teamBId = teamBId;
  }

  if (requireAll || body.startTimeUtc !== undefined) {
    const st = toMysqlUtc(body.startTimeUtc);
    if (!st) throw new AppError(400, 'BAD_START_TIME', 'startTimeUtc must be a valid ISO-8601 datetime');
    out.startTime = st;
  }

  if (requireAll || body.timezone !== undefined) {
    const tz = String(body.timezone || 'UTC');
    if (!TZ_RE.test(tz)) throw new AppError(400, 'BAD_TIMEZONE', 'timezone must be an IANA zone name like Asia/Kolkata');
    out.timezone = tz;
  }

  if (requireAll || body.format !== undefined) out.format = String(body.format || 'T20').slice(0, 20);
  if (requireAll || body.venue !== undefined) out.venue = body.venue == null ? null : String(body.venue).slice(0, 200);
  if (requireAll || body.autoStart !== undefined) out.autoStart = body.autoStart === undefined ? 1 : (body.autoStart ? 1 : 0);

  return out;
}

async function rebuildMatchPlayers(conn, matchId, teamAId, teamBId) {
  await conn.query('DELETE FROM match_players WHERE match_id = ?', [matchId]);
  await conn.query(
    `INSERT INTO match_players (match_id, player_id)
       SELECT ?, p.id FROM players p WHERE p.team_id IN (?, ?)`,
    [matchId, teamAId, teamBId]
  );
}

/** POST /api/admin/matches — create a manual match (full squads become the playing pool) */
exports.createMatch = async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const f = await validateMatchPayload(req.body, { requireAll: true });

    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO matches (team_a_id, team_b_id, format, venue, start_time, timezone, auto_start, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'UPCOMING')`,
      [f.teamAId, f.teamBId, f.format, f.venue, f.startTime, f.timezone, f.autoStart]
    );
    const matchId = r.insertId;
    await rebuildMatchPlayers(conn, matchId, f.teamAId, f.teamBId);
    await conn.commit();

    return ok(res, { id: matchId, status: 'UPCOMING' }, 201);
  } catch (e) {
    await conn.rollback().catch(() => {});
    next(e);
  } finally {
    conn.release();
  }
};

/** PATCH /api/admin/matches/:id — edit an UPCOMING match */
exports.updateMatch = async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const matchId = Number(req.params.id);
    const [[match]] = await pool.query(
      `SELECT m.*, (SELECT COUNT(*) FROM user_teams WHERE match_id = m.id) AS entries
         FROM matches m WHERE m.id = ?`,
      [matchId]
    );
    if (!match) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
    if (match.status !== 'UPCOMING') {
      throw new AppError(400, 'NOT_EDITABLE', `Only UPCOMING matches can be edited (this one is ${match.status})`);
    }
    if (match.external_id != null) {
      throw new AppError(400, 'EXTERNAL_MATCH', 'Sportmonks fixtures are managed by the sync, not editable here');
    }

    const f = await validateMatchPayload(req.body, { requireAll: false });

    const teamsChanging =
      (f.teamAId !== undefined && f.teamAId !== match.team_a_id) ||
      (f.teamBId !== undefined && f.teamBId !== match.team_b_id);
    if (teamsChanging && Number(match.entries) > 0) {
      throw new AppError(400, 'HAS_ENTRIES',
        `${match.entries} user team(s) already entered — teams can no longer be changed. Delete the match instead.`);
    }

    const sets = [];
    const params = [];
    if (f.teamAId !== undefined) { sets.push('team_a_id = ?'); params.push(f.teamAId); }
    if (f.teamBId !== undefined) { sets.push('team_b_id = ?'); params.push(f.teamBId); }
    if (f.format !== undefined) { sets.push('format = ?'); params.push(f.format); }
    if (f.venue !== undefined) { sets.push('venue = ?'); params.push(f.venue); }
    if (f.startTime !== undefined) { sets.push('start_time = ?'); params.push(f.startTime); }
    if (f.timezone !== undefined) { sets.push('timezone = ?'); params.push(f.timezone); }
    if (f.autoStart !== undefined) { sets.push('auto_start = ?'); params.push(f.autoStart); }
    if (!sets.length) return ok(res, { id: matchId, updated: false });

    await conn.beginTransaction();
    await conn.query(`UPDATE matches SET ${sets.join(', ')} WHERE id = ?`, [...params, matchId]);
    if (teamsChanging) {
      await rebuildMatchPlayers(
        conn, matchId,
        f.teamAId !== undefined ? f.teamAId : match.team_a_id,
        f.teamBId !== undefined ? f.teamBId : match.team_b_id
      );
    }
    await conn.commit();

    return ok(res, { id: matchId, updated: true });
  } catch (e) {
    await conn.rollback().catch(() => {});
    next(e);
  } finally {
    conn.release();
  }
};

/** DELETE /api/admin/matches/:id — remove an UPCOMING match (and any entries on it) */
exports.deleteMatch = async (req, res, next) => {
  try {
    const matchId = Number(req.params.id);
    const [[match]] = await pool.query('SELECT id, status FROM matches WHERE id = ?', [matchId]);
    if (!match) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
    if (match.status !== 'UPCOMING') {
      throw new AppError(400, 'NOT_DELETABLE', `Only UPCOMING matches can be deleted (this one is ${match.status})`);
    }

    // user_teams has no ON DELETE CASCADE to matches — remove entries first
    // (user_team_players cascades from user_teams; events/stats/match_players/state cascade from matches)
    await pool.query('DELETE FROM user_teams WHERE match_id = ?', [matchId]);
    await pool.query('DELETE FROM matches WHERE id = ?', [matchId]);

    return ok(res, { id: matchId, deleted: true });
  } catch (e) { next(e); }
};
