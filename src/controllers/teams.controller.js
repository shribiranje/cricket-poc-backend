const pool = require('../config/db');
const config = require('../config');
const { ok, AppError } = require('../utils/response');

/**
 * Validate role composition + budget + captain/vc + duplicates.
 * Throws AppError on any violation.
 */
function validateComposition(players, captainId, viceCaptainId) {
  const r = config.rules;

  // exact size
  if (players.length !== r.teamSize) {
    throw new AppError(400, 'INVALID_TEAM_SIZE', `Team must contain exactly ${r.teamSize} players`);
  }

  // dedupe
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) {
    throw new AppError(400, 'DUPLICATE_PLAYERS', 'Duplicate players are not allowed');
  }
  if (!ids.has(captainId)) throw new AppError(400, 'INVALID_CAPTAIN', 'Captain must be part of the team');
  if (!ids.has(viceCaptainId)) throw new AppError(400, 'INVALID_VICE_CAPTAIN', 'Vice-captain must be part of the team');
  if (captainId === viceCaptainId) {
    throw new AppError(400, 'CAPTAIN_VC_SAME', 'Captain and vice-captain must be different players');
  }

  // budget
  const totalCredits = players.reduce((s, p) => s + Number(p.credit), 0);
  if (totalCredits > r.creditBudget) {
    throw new AppError(400, 'BUDGET_EXCEEDED',
      `Total credits used (${totalCredits}) exceeds budget (${r.creditBudget})`);
  }

  // role counts
  const count = { BATSMAN: 0, BOWLER: 0, ALL_ROUNDER: 0, WICKET_KEEPER: 0 };
  players.forEach((p) => { count[p.role] = (count[p.role] || 0) + 1; });

  const checks = [
    ['BATSMAN',       r.minBatsmen,        'MIN_BATSMEN'],
    ['BOWLER',        r.minBowlers,        'MIN_BOWLERS'],
    ['ALL_ROUNDER',   r.minAllRounders,    'MIN_ALL_ROUNDERS'],
    ['WICKET_KEEPER', r.minWicketKeepers,  'MIN_WICKET_KEEPERS'],
  ];
  for (const [role, min, code] of checks) {
    if ((count[role] || 0) < min) {
      throw new AppError(400, code, `Team must have at least ${min} ${role.toLowerCase()}(s)`);
    }
    if ((count[role] || 0) > r.maxPerRole) {
      throw new AppError(400, 'MAX_PER_ROLE_EXCEEDED',
        `Cannot have more than ${r.maxPerRole} ${role.toLowerCase()}(s)`);
    }
  }

  return { totalCredits };
}

/**
 * POST /api/matches/:id/teams
 * body: { playerIds: number[], captainId, viceCaptainId }
 */
exports.submit = async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const matchId = Number(req.params.id);
    const userId = req.userId;
    const { playerIds, captainId, viceCaptainId } = req.body;

    // 1. Match must exist and be UPCOMING
    const [[match]] = await conn.query('SELECT status FROM matches WHERE id = ?', [matchId]);
    if (!match) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
    if (match.status !== 'UPCOMING') {
      throw new AppError(400, 'MATCH_LOCKED', 'Team can only be created before the match starts');
    }

    // 2. All player ids must belong to this match
    const [pRows] = await conn.query(
      `SELECT p.id, p.name, p.role, p.credit FROM match_players mp
         JOIN players p ON p.id = mp.player_id
        WHERE mp.match_id = ? AND p.id IN (?)`,
      [matchId, playerIds]
    );
    if (pRows.length !== playerIds.length) {
      throw new AppError(400, 'INVALID_PLAYERS',
        'One or more selected players are not part of this match');
    }

    // 3. Validate composition
    const { totalCredits } = validateComposition(pRows, captainId, viceCaptainId);

    await conn.beginTransaction();

    // 4. Upsert user_team (unique by user_id + match_id)
    const [[existing]] = await conn.query(
      'SELECT id, is_locked FROM user_teams WHERE user_id = ? AND match_id = ?',
      [userId, matchId]
    );
    if (existing && existing.is_locked) {
      throw new AppError(400, 'TEAM_LOCKED', 'Your team for this match is already locked');
    }

    let userTeamId;
    if (existing) {
      userTeamId = existing.id;
      await conn.query(
        `UPDATE user_teams
            SET captain_player_id = ?, vice_captain_player_id = ?, total_credits_used = ?
          WHERE id = ?`,
        [captainId, viceCaptainId, totalCredits, userTeamId]
      );
      await conn.query('DELETE FROM user_team_players WHERE user_team_id = ?', [userTeamId]);
    } else {
      const [ins] = await conn.query(
        `INSERT INTO user_teams (user_id, match_id, captain_player_id, vice_captain_player_id, total_credits_used)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, matchId, captainId, viceCaptainId, totalCredits]
      );
      userTeamId = ins.insertId;
    }

    for (const p of pRows) {
      await conn.query(
        'INSERT INTO user_team_players (user_team_id, player_id) VALUES (?, ?)',
        [userTeamId, p.id]
      );
    }

    await conn.commit();
    return ok(res, { userTeamId, totalCreditsUsed: totalCredits }, existing ? 200 : 201);
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    next(e);
  } finally {
    conn.release();
  }
};

/** GET /api/matches/:id/teams/me */
exports.getMine = async (req, res, next) => {
  try {
    const matchId = Number(req.params.id);
    const userId = req.userId;
    const [[ut]] = await pool.query(
      `SELECT ut.id, ut.captain_player_id, ut.vice_captain_player_id,
              ut.total_credits_used, ut.total_points, ut.is_locked, ut.created_at
         FROM user_teams ut
        WHERE ut.user_id = ? AND ut.match_id = ?`,
      [userId, matchId]
    );
    if (!ut) return ok(res, null);

    const [players] = await pool.query(
      `SELECT p.id, p.name, p.role, p.credit, t.short_name AS team_short,
              COALESCE(s.points, 0) AS points
         FROM user_team_players utp
         JOIN players p ON p.id = utp.player_id
         JOIN teams t   ON t.id = p.team_id
    LEFT JOIN player_match_stats s ON s.match_id = ? AND s.player_id = p.id
        WHERE utp.user_team_id = ?`,
      [matchId, ut.id]
    );

    return ok(res, {
      id: ut.id,
      captainId: ut.captain_player_id,
      viceCaptainId: ut.vice_captain_player_id,
      totalCreditsUsed: Number(ut.total_credits_used),
      totalPoints: Number(ut.total_points),
      isLocked: !!ut.is_locked,
      createdAt: ut.created_at,
      players: players.map((p) => ({
        id: p.id, name: p.name, role: p.role,
        credit: Number(p.credit), teamShort: p.team_short,
        points: Number(p.points),
        isCaptain: p.id === ut.captain_player_id,
        isViceCaptain: p.id === ut.vice_captain_player_id,
      })),
    });
  } catch (e) { next(e); }
};
