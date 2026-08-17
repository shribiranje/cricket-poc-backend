/**
 * Ball/over prediction game — free-to-play, virtual points only.
 *
 * Placement: while a match is LIVE, users predict the outcome of a future
 * ball (or a not-yet-started over). The window for a ball closes the moment
 * it is bowled; an over locks once its first ball is bowled.
 *
 * Resolution paths:
 *   - Engine matches: matchEngine.playBalls() calls resolveEngineEvents()
 *     with the batch it just played (each event's meta carries innings/over/ball).
 *   - RapidAPI matches: rapidapi.service.js calls resolveDelivery()/resolveOver()
 *     as it ingests the live feed.
 *   - matchLifecycle.completeMatch() voids + refunds anything still OPEN.
 *
 * Progress source: match_state (engine matches) with a rapidapi_cursor
 * fallback (external matches). Progress = { innings, ballsBowled } where
 * ballsBowled counts legal deliveries in the current innings.
 */
const pool = require('../config/db');
const config = require('../config');
const { AppError } = require('../utils/response');

const P = config.predictions;

// Payout multipliers (virtual points) — rough inverse of outcome frequency.
const BALL_MULTIPLIERS = {
  DOT: 3, SINGLE: 2.5, TWO_THREE: 4, FOUR: 4.5, SIX: 7, WICKET: 8, EXTRA: 6,
};
const OVER_MULTIPLIERS = {
  RUNS_0_3: 3, RUNS_4_7: 2.5, RUNS_8_11: 3.5, RUNS_12_PLUS: 5, WICKET_IN_OVER: 2,
};

/** Map one delivery to a BALL outcome. */
function classifyBall({ runs, isWicket, isExtra }) {
  if (isWicket) return 'WICKET';
  if (isExtra) return 'EXTRA'; // never fires on engine matches (all deliveries legal)
  if (runs === 0) return 'DOT';
  if (runs === 1) return 'SINGLE';
  if (runs === 4) return 'FOUR';
  if (runs === 6) return 'SIX';
  return 'TWO_THREE'; // 2, 3 (and rare 5s) for POC simplicity
}

/** Map an over's total runs to its OVER bucket. */
function classifyOverRuns(totalRuns) {
  if (totalRuns <= 3) return 'RUNS_0_3';
  if (totalRuns <= 7) return 'RUNS_4_7';
  if (totalRuns <= 11) return 'RUNS_8_11';
  return 'RUNS_12_PLUS';
}

async function ensureWallet(userId) {
  const [ins] = await pool.query(
    'INSERT IGNORE INTO prediction_wallets (user_id, balance) VALUES (?, ?)',
    [userId, P.startingBalance]
  );
  if (ins.affectedRows) {
    await logTx(null, userId, 'STARTING_GRANT', P.startingBalance, P.startingBalance,
      null, 'Welcome bonus');
  }
  const [[wallet]] = await pool.query(
    'SELECT user_id, balance FROM prediction_wallets WHERE user_id = ?', [userId]
  );
  return wallet;
}

/** Insert a ledger row. Pass `conn` when inside a transaction. */
async function logTx(conn, userId, type, amount, balanceAfter, predictionId = null, note = null) {
  const q = conn || pool;
  await q.query(
    `INSERT INTO wallet_transactions
       (user_id, type, amount, balance_after, prediction_id, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, type, amount, balanceAfter, predictionId, note ? String(note).slice(0, 255) : null]
  );
}

async function readBalance(conn, userId) {
  const [[w]] = await conn.query(
    'SELECT balance FROM prediction_wallets WHERE user_id = ?', [userId]
  );
  return w ? w.balance : 0;
}

/** { innings, ballsBowled, finished } for a match, from whichever source drives it. */
async function getMatchProgress(matchId) {
  const [[st]] = await pool.query(
    'SELECT innings, legal_balls, finished FROM match_state WHERE match_id = ?',
    [matchId]
  );
  if (st) {
    return { innings: st.innings, ballsBowled: st.legal_balls, finished: !!st.finished };
  }
  const [[cur]] = await pool.query(
    'SELECT innings, over_number, ball_number FROM rapidapi_cursor WHERE match_id = ?',
    [matchId]
  );
  if (cur) {
    return { innings: cur.innings, ballsBowled: cur.over_number * 6 + cur.ball_number, finished: false };
  }
  return { innings: 1, ballsBowled: 0, finished: false };
}

async function placePrediction(userId, matchId, body) {
  const scope = body.scope;
  const innings = Number(body.innings);
  const over = Number(body.over_number);
  const ball = scope === 'BALL' ? Number(body.ball_number) : 0;
  const predicted = body.predicted;
  const stake = Math.floor(Number(body.stake));

  if (!['BALL', 'OVER'].includes(scope)) {
    throw new AppError(400, 'INVALID_SCOPE', 'scope must be BALL or OVER');
  }
  const table = scope === 'BALL' ? BALL_MULTIPLIERS : OVER_MULTIPLIERS;
  if (!table[predicted]) {
    throw new AppError(400, 'INVALID_OUTCOME', `"${predicted}" is not a valid ${scope} outcome`);
  }
  if (![1, 2, 3, 4].includes(innings) || !(over >= 0)) {
    throw new AppError(400, 'INVALID_TARGET', 'innings must be 1-4 and over_number >= 0');
  }
  if (scope === 'BALL' && !(ball >= 1 && ball <= 6)) {
    throw new AppError(400, 'INVALID_TARGET', 'ball_number must be 1-6 for BALL scope');
  }
  if (!(stake >= P.minStake && stake <= P.maxStake)) {
    throw new AppError(400, 'INVALID_STAKE', `stake must be between ${P.minStake} and ${P.maxStake}`);
  }

  const [[match]] = await pool.query('SELECT id, status FROM matches WHERE id = ?', [matchId]);
  if (!match) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');
  if (match.status !== 'LIVE') {
    throw new AppError(409, 'MATCH_NOT_LIVE', 'Predictions are only open while the match is LIVE');
  }

  const p = await getMatchProgress(matchId);
  const open =
    scope === 'BALL'
      ? innings > p.innings || (innings === p.innings && over * 6 + ball > p.ballsBowled)
      : innings > p.innings || (innings === p.innings && over * 6 >= p.ballsBowled);
  if (p.finished || !open) {
    throw new AppError(409, 'WINDOW_CLOSED',
      scope === 'BALL' ? 'That ball has already been bowled' : 'That over has already started');
  }

  await ensureWallet(userId);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [debit] = await conn.query(
      'UPDATE prediction_wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?',
      [stake, userId, stake]
    );
    if (!debit.affectedRows) {
      throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Not enough prediction points');
    }
    const [ins] = await conn.query(
      `INSERT INTO predictions
         (user_id, match_id, scope, innings, over_number, ball_number, predicted, stake)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, matchId, scope, innings, over, ball, predicted, stake]
    );
    const bal = await readBalance(conn, userId);
    await logTx(conn, userId, 'STAKE', -stake, bal, ins.insertId,
      `${scope} ${predicted} · match #${matchId}`);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      throw new AppError(409, 'ALREADY_PREDICTED', 'You already have a prediction on this ball/over');
    }
    throw err;
  } finally {
    conn.release();
  }
  return { placed: true };
}

/** Resolve BALL predictions for one delivery (after it has been recorded). */
async function resolveDelivery(matchId, d) {
  const actual = classifyBall(d);
  const [rows] = await pool.query(
    `SELECT id, user_id, predicted, stake FROM predictions
      WHERE match_id = ? AND scope = 'BALL' AND status = 'OPEN'
        AND innings = ? AND over_number = ? AND ball_number = ?`,
    [matchId, d.innings, d.over_number, d.ball_number]
  );
  for (const p of rows) {
    const won = p.predicted === actual;
    await settle(p, won, won ? Math.round(p.stake * BALL_MULTIPLIERS[p.predicted]) : 0, actual);
  }
}

/** Resolve OVER predictions for a completed (or innings-truncated) over. */
async function resolveOver(matchId, innings, overNumber, { totalRuns, hadWicket }) {
  const runsBucket = classifyOverRuns(totalRuns);
  const actual = hadWicket ? `${runsBucket}+W` : runsBucket;
  const [rows] = await pool.query(
    `SELECT id, user_id, predicted, stake FROM predictions
      WHERE match_id = ? AND scope = 'OVER' AND status = 'OPEN'
        AND innings = ? AND over_number = ?`,
    [matchId, innings, overNumber]
  );
  for (const p of rows) {
    const won = p.predicted === 'WICKET_IN_OVER' ? hadWicket : p.predicted === runsBucket;
    await settle(p, won, won ? Math.round(p.stake * OVER_MULTIPLIERS[p.predicted]) : 0, actual);
  }
}

/**
 * Resolve a batch of engine deliveries after matchEngine.playBalls() flushed
 * them. `events` is the engine's array: [batsmanId, type, value, meta] where
 * meta = { bowler, innings, over, ball, ... } and value = runs off the bat.
 */
async function resolveEngineEvents(matchId, events) {
  const touched = new Map(); // "innings:over" -> { innings, over }
  for (const [, type, value, meta] of events) {
    if (!meta || meta.innings == null) continue;
    const d = {
      innings: meta.innings,
      over_number: meta.over,
      ball_number: meta.ball,
      runs: Number(value) || 0,
      isWicket: type === 'WICKET',
      isExtra: false,
    };
    await resolveDelivery(matchId, d);
    touched.set(`${d.innings}:${d.over_number}`, { innings: d.innings, over: d.over_number });
  }
  if (!touched.size) return;

  // An over resolves when it has 6 legal balls, or its innings ended early.
  const [[st]] = await pool.query(
    'SELECT innings, legal_balls, finished FROM match_state WHERE match_id = ?', [matchId]
  );
  if (!st) return;
  for (const t of touched.values()) {
    const done =
      t.innings < st.innings || !!st.finished ||
      (t.innings === st.innings && st.legal_balls >= (t.over + 1) * 6);
    if (!done) continue;
    const [[sum]] = await pool.query(
      `SELECT COALESCE(SUM(value), 0) AS total,
              COALESCE(MAX(event_type = 'WICKET'), 0) AS hadW
         FROM match_events
        WHERE match_id = ?
          AND CAST(JSON_EXTRACT(meta, '$.innings') AS UNSIGNED) = ?
          AND CAST(JSON_EXTRACT(meta, '$.over') AS UNSIGNED) = ?`,
      [matchId, t.innings, t.over]
    );
    await resolveOver(matchId, t.innings, t.over, {
      totalRuns: Number(sum.total), hadWicket: !!Number(sum.hadW),
    });
  }
}

/** Void + refund anything still open. Called by lifecycle on completion. */
async function voidOpenForMatch(matchId) {
  const [rows] = await pool.query(
    `SELECT id, user_id, stake FROM predictions WHERE match_id = ? AND status = 'OPEN'`,
    [matchId]
  );
  for (const p of rows) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.query(
        `UPDATE predictions SET status = 'VOID', resolved_at = NOW()
          WHERE id = ? AND status = 'OPEN'`, [p.id]
      );
      if (r.affectedRows) {
        await conn.query(
          'UPDATE prediction_wallets SET balance = balance + ? WHERE user_id = ?',
          [p.stake, p.user_id]
        );
        const bal = await readBalance(conn, p.user_id);
        await logTx(conn, p.user_id, 'REFUND', p.stake, bal, p.id, `Void refund · match #${matchId}`);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
  return { voided: rows.length };
}

async function settle(prediction, won, payout, actual) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `UPDATE predictions
          SET status = ?, actual = ?, payout = ?, resolved_at = NOW()
        WHERE id = ? AND status = 'OPEN'`,
      [won ? 'WON' : 'LOST', actual, payout, prediction.id]
    );
    if (r.affectedRows && won && payout > 0) {
      await conn.query(
        'UPDATE prediction_wallets SET balance = balance + ? WHERE user_id = ?',
        [payout, prediction.user_id]
      );
      const bal = await readBalance(conn, prediction.user_id);
      await logTx(conn, prediction.user_id, 'PAYOUT', payout, bal, prediction.id,
        `Won ${prediction.predicted || ''}`.trim());
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function myPredictions(userId, matchId) {
  const [rows] = await pool.query(
    `SELECT id, scope, innings, over_number, ball_number, predicted, actual,
            stake, payout, status, created_at, resolved_at
       FROM predictions WHERE user_id = ? AND match_id = ?
      ORDER BY id DESC LIMIT 100`,
    [userId, matchId]
  );
  return rows;
}

async function leaderboard(matchId) {
  const [rows] = await pool.query(
    `SELECT u.id AS userId, u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl,
            COUNT(*) AS settled, SUM(p.status = 'WON') AS won,
            CAST(SUM(p.payout) - SUM(p.stake) AS SIGNED) AS netPoints
       FROM predictions p
       JOIN users u ON u.id = p.user_id
      WHERE p.match_id = ? AND p.status IN ('WON','LOST')
      GROUP BY u.id, u.username, u.display_name, u.avatar_url
      ORDER BY netPoints DESC, won DESC
      LIMIT 50`,
    [matchId]
  );
  return rows;
}

const BUY_PRESETS = [100, 500, 1000, 2500, 5000];

/** Free top-up — no payment gateway; credits virtual points. */
async function buyPoints(userId, amount) {
  const amt = Math.floor(Number(amount));
  if (!BUY_PRESETS.includes(amt)) {
    throw new AppError(400, 'BAD_AMOUNT', `amount must be one of: ${BUY_PRESETS.join(', ')}`);
  }
  await ensureWallet(userId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'UPDATE prediction_wallets SET balance = balance + ? WHERE user_id = ?',
      [amt, userId]
    );
    const bal = await readBalance(conn, userId);
    await logTx(conn, userId, 'PURCHASE', amt, bal, null, `Bought ${amt} points`);
    await conn.commit();
    return { balance: bal, purchased: amt };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function listTransactions(userId, { limit = 50, offset = 0 } = {}) {
  await ensureWallet(userId);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const [[countRow]] = await pool.query(
    'SELECT COUNT(*) AS c FROM wallet_transactions WHERE user_id = ?', [userId]
  );
  const [rows] = await pool.query(
    `SELECT id, type, amount, balance_after AS balanceAfter, prediction_id AS predictionId,
            note, created_at AS createdAt
       FROM wallet_transactions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
    [userId, lim, off]
  );
  const wallet = await ensureWallet(userId);
  return {
    balance: wallet.balance,
    buyPresets: BUY_PRESETS,
    total: Number(countRow.c),
    limit: lim,
    offset: off,
    transactions: rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: r.amount,
      balanceAfter: r.balanceAfter,
      predictionId: r.predictionId,
      note: r.note,
      createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
    })),
  };
}

async function listAllBets(userId, { limit = 50, offset = 0, status = null } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  const allowed = new Set(['OPEN', 'WON', 'LOST', 'VOID']);
  const statusFilter = status && allowed.has(String(status).toUpperCase())
    ? String(status).toUpperCase()
    : null;

  const params = [userId];
  let where = 'WHERE p.user_id = ?';
  if (statusFilter) {
    where += ' AND p.status = ?';
    params.push(statusFilter);
  }

  const [[countRow]] = await pool.query(
    `SELECT COUNT(*) AS c FROM predictions p ${where}`, params
  );
  const [rows] = await pool.query(
    `SELECT p.id, p.match_id AS matchId, p.scope, p.innings, p.over_number AS overNumber,
            p.ball_number AS ballNumber, p.predicted, p.actual, p.stake, p.payout, p.status,
            p.created_at AS createdAt, p.resolved_at AS resolvedAt,
            ta.short_name AS teamAShort, tb.short_name AS teamBShort, m.status AS matchStatus
       FROM predictions p
       JOIN matches m ON m.id = p.match_id
       JOIN teams ta ON ta.id = m.team_a_id
       JOIN teams tb ON tb.id = m.team_b_id
       ${where}
      ORDER BY p.id DESC
      LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );

  return {
    total: Number(countRow.c),
    limit: lim,
    offset: off,
    bets: rows.map((r) => ({
      id: r.id,
      matchId: r.matchId,
      fixture: `${r.teamAShort} vs ${r.teamBShort}`,
      matchStatus: r.matchStatus,
      scope: r.scope,
      innings: r.innings,
      overNumber: r.overNumber,
      ballNumber: r.ballNumber,
      predicted: r.predicted,
      actual: r.actual,
      stake: r.stake,
      payout: r.payout,
      status: r.status,
      net: r.status === 'WON' ? r.payout - r.stake
        : r.status === 'LOST' ? -r.stake
          : r.status === 'VOID' ? 0 : null,
      createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
      resolvedAt: r.resolvedAt
        ? (r.resolvedAt instanceof Date ? r.resolvedAt : new Date(r.resolvedAt)).toISOString()
        : null,
    })),
  };
}

async function getUserAnalytics(userId) {
  await ensureWallet(userId);
  const [[s]] = await pool.query(
    `SELECT
        COUNT(*) AS totalBets,
        SUM(status = 'WON') AS wins,
        SUM(status = 'LOST') AS losses,
        SUM(status = 'VOID') AS voids,
        SUM(status = 'OPEN') AS openBets,
        COALESCE(SUM(stake), 0) AS totalStaked,
        COALESCE(SUM(CASE WHEN status IN ('WON','LOST') THEN stake ELSE 0 END), 0) AS settledStake,
        COALESCE(SUM(CASE WHEN status = 'WON' THEN payout ELSE 0 END), 0) AS totalPayout,
        COALESCE(SUM(CASE WHEN status = 'WON' THEN payout - stake
                          WHEN status = 'LOST' THEN -stake ELSE 0 END), 0) AS netPoints
       FROM predictions WHERE user_id = ?`,
    [userId]
  );

  const [byStatus] = await pool.query(
    `SELECT status, COUNT(*) AS count FROM predictions WHERE user_id = ? GROUP BY status`,
    [userId]
  );
  const [byPredicted] = await pool.query(
    `SELECT predicted AS label, COUNT(*) AS count
       FROM predictions WHERE user_id = ?
      GROUP BY predicted ORDER BY count DESC LIMIT 12`,
    [userId]
  );
  const [byDay] = await pool.query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS bets,
            COALESCE(SUM(CASE WHEN status = 'WON' THEN payout - stake
                              WHEN status = 'LOST' THEN -stake ELSE 0 END), 0) AS net
       FROM predictions
      WHERE user_id = ? AND created_at >= UTC_DATE() - INTERVAL 13 DAY
      GROUP BY DATE(created_at)
      ORDER BY day ASC`,
    [userId]
  );
  const [byScope] = await pool.query(
    `SELECT scope, COUNT(*) AS count FROM predictions WHERE user_id = ? GROUP BY scope`,
    [userId]
  );

  const wins = Number(s.wins || 0);
  const losses = Number(s.losses || 0);
  const settled = wins + losses;

  return {
    summary: {
      totalBets: Number(s.totalBets || 0),
      wins,
      losses,
      voids: Number(s.voids || 0),
      openBets: Number(s.openBets || 0),
      totalStaked: Number(s.totalStaked || 0),
      totalPayout: Number(s.totalPayout || 0),
      netPoints: Number(s.netPoints || 0),
      winRate: settled ? Math.round((wins / settled) * 1000) / 10 : 0,
    },
    pieByStatus: byStatus.map((r) => ({ label: r.status, value: Number(r.count) })),
    pieByPrediction: byPredicted.map((r) => ({ label: r.label, value: Number(r.count) })),
    pieByScope: byScope.map((r) => ({ label: r.scope, value: Number(r.count) })),
    daily: byDay.map((r) => ({
      day: r.day instanceof Date
        ? r.day.toISOString().slice(0, 10)
        : String(r.day).slice(0, 10),
      bets: Number(r.bets),
      net: Number(r.net),
    })),
  };
}

module.exports = {
  ensureWallet, placePrediction, getMatchProgress,
  resolveDelivery, resolveOver, resolveEngineEvents, voidOpenForMatch,
  myPredictions, leaderboard, classifyBall, classifyOverRuns,
  buyPoints, listTransactions, listAllBets, getUserAnalytics, BUY_PRESETS,
  MULTIPLIERS: { BALL: BALL_MULTIPLIERS, OVER: OVER_MULTIPLIERS },
};
