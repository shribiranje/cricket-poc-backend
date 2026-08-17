/**
 * Ball-aware match engine (simulator v2)
 * ---------------------------------------
 * Upgrades the old "random event every tick" simulator into a real innings
 * engine. It tracks: innings (1/2), batting/bowling team, over.ball, wickets,
 * strike rotation, batting order, per-bowler over limits, target chases, and
 * a match result — while writing to the SAME tables the old simulator used
 * (match_events, player_match_stats), so the scoring engine, leaderboard and
 * user-team recalc are untouched.
 *
 * Autoplay is INSTANT: playBalls() simulates the requested span fully
 * in memory, then flushes everything in one transaction (batch event insert
 * + per-player stat deltas), recomputes fantasy points ONCE, and recalcs all
 * user teams ONCE. A full T20 finishes in well under a second.
 *
 * Modes: BALL_1 | OVER_1 | OVER_5 | INNINGS | END_MATCH
 *   INNINGS   → plays until the innings that was live at call time ends
 *   END_MATCH → plays to the natural end of innings 2, then COMPLETEs the match
 *
 * Guard: refuses matches with an external_id (Sportmonks fixtures are driven
 * by the real feed, not the engine).
 *
 * Simplifications (documented on purpose, all POC-safe):
 *   - every delivery is legal (no wides/no-balls — the stats schema has no
 *     extras columns)
 *   - a WICKET always dismisses the striker and credits the bowler
 *     (~55% caught, ~12% stumped by the keeper, rest bowled/lbw; no run-outs)
 *   - toss is random; batting order = BAT → WK → AR → BOWL by credit
 */
const pool = require('../config/db');
const { AppError } = require('../utils/response');
const { calcPoints } = require('./scoring.service');
const { recalcAllForMatch } = require('./userTeamScore.service');
const lifecycle = require('./matchLifecycle.service');

const EVENT_WEIGHTS = [
  { type: 'DOT_BALL', w: 35, runs: 0 },
  { type: 'RUN_1',    w: 25, runs: 1 },
  { type: 'RUN_2',    w: 10, runs: 2 },
  { type: 'RUN_3',    w: 3,  runs: 3 },
  { type: 'FOUR',     w: 12, runs: 4 },
  { type: 'SIX',      w: 7,  runs: 6 },
  { type: 'WICKET',   w: 8,  runs: 0 },
];

const MODES = {
  BALL_1:    { balls: 1 },
  OVER_1:    { balls: 6 },
  OVER_5:    { balls: 30 },
  INNINGS:   { untilInningsEnd: true },
  END_MATCH: { untilMatchEnd: true },
};

/** Overs per innings by format string. */
function oversForFormat(format) {
  const f = String(format || '').toUpperCase();
  if (f.includes('T10')) return 10;
  if (f.includes('ODI') || f.includes('50')) return 50;
  return 20; // T20 and anything unrecognized
}

function pickWeighted(items) {
  const total = items.reduce((a, b) => a + b.w, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const fmtOvers = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;

/** Batting order: openers are the best batters; bowlers walk in last. */
function battingOrder(players) {
  const rank = { BATSMAN: 0, WICKET_KEEPER: 1, ALL_ROUNDER: 2, BOWLER: 3 };
  return [...players]
    .sort((a, b) => (rank[a.role] - rank[b.role]) || (Number(b.credit) - Number(a.credit)))
    .map((p) => p.id);
}

/**
 * The playing XI: match_players may hold a full squad (e.g. 15), but only 11
 * take the field. We keep the best batters plus the tail so wickets cap at 10,
 * exactly like real cricket. Ordering trick: take the top batters and the
 * genuine bowlers so there's always someone to bowl the overs.
 */
function playingEleven(squad) {
  if (squad.length <= 11) return battingOrder(squad);
  const rank = { BATSMAN: 0, WICKET_KEEPER: 1, ALL_ROUNDER: 2, BOWLER: 3 };
  const byRole = (role) => squad
    .filter((p) => p.role === role)
    .sort((a, b) => Number(b.credit) - Number(a.credit));
  const picked = [];
  const take = (arr, n) => arr.slice(0, n).forEach((p) => picked.push(p));
  take(byRole('BATSMAN'), 4);
  take(byRole('WICKET_KEEPER'), 1);
  take(byRole('ALL_ROUNDER'), 2);
  take(byRole('BOWLER'), 4);
  // Top up to 11 with the best remaining players of any role
  const rest = squad
    .filter((p) => !picked.includes(p))
    .sort((a, b) => (rank[a.role] - rank[b.role]) || (Number(b.credit) - Number(a.credit)));
  while (picked.length < 11 && rest.length) picked.push(rest.shift());
  return battingOrder(picked);
}

async function loadMatchAndSquads(matchId) {
  const [[match]] = await pool.query(
    `SELECT m.id, m.team_a_id, m.team_b_id, m.format, m.status, m.external_id,
            ta.short_name AS team_a_short, tb.short_name AS team_b_short
       FROM matches m
       JOIN teams ta ON ta.id = m.team_a_id
       JOIN teams tb ON tb.id = m.team_b_id
      WHERE m.id = ?`,
    [matchId]
  );
  if (!match) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');

  const [players] = await pool.query(
    `SELECT p.id, p.team_id, p.role, p.credit
       FROM match_players mp
       JOIN players p ON p.id = mp.player_id
      WHERE mp.match_id = ?`,
    [matchId]
  );

  const squad = (teamId) => players.filter((p) => p.team_id === teamId);
  const shorts = { [match.team_a_id]: match.team_a_short, [match.team_b_id]: match.team_b_short };
  return { match, players, squad, shorts };
}

function parseMeta(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
  return raw; // mysql2 may already have parsed the JSON column
}

/**
 * Create the innings-1 state row for a match (idempotent — returns the
 * existing row when one is already there).
 */
async function initState(matchId) {
  const [[existing]] = await pool.query('SELECT * FROM match_state WHERE match_id = ?', [matchId]);
  if (existing) return existing;

  const { match, squad } = await loadMatchAndSquads(matchId);
  const squadA = squad(match.team_a_id);
  const squadB = squad(match.team_b_id);
  if (squadA.length < 2 || squadB.length < 2) {
    throw new AppError(400, 'NOT_ENOUGH_PLAYERS',
      'Both teams need at least 2 players in the playing squad to simulate');
  }

  // Random toss
  const battingTeamId = Math.random() < 0.5 ? match.team_a_id : match.team_b_id;
  const bowlingTeamId = battingTeamId === match.team_a_id ? match.team_b_id : match.team_a_id;

  const orders = {
    [match.team_a_id]: playingEleven(squadA),
    [match.team_b_id]: playingEleven(squadB),
  };
  const meta = { orders, dismissed: [], bowlerBalls: {}, lastBowlerId: null };

  const batOrder = orders[battingTeamId];
  const strikerId = batOrder[0];
  const nonStrikerId = batOrder[1];
  const bowlingXi = squad(bowlingTeamId).filter((p) => orders[bowlingTeamId].includes(p.id));
  const bowlerId = chooseBowler(bowlingXi, meta, maxBallsPerBowler(match.format), null);

  await pool.query(
    `INSERT INTO match_state
       (match_id, innings, batting_team_id, bowling_team_id, runs, wickets, legal_balls,
        striker_id, non_striker_id, bowler_id, meta)
     VALUES (?, 1, ?, ?, 0, 0, 0, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE match_id = match_id`,
    [matchId, battingTeamId, bowlingTeamId, strikerId, nonStrikerId, bowlerId, JSON.stringify(meta)]
  );
  const [[row]] = await pool.query('SELECT * FROM match_state WHERE match_id = ?', [matchId]);
  return row;
}

function maxBallsPerBowler(format) {
  const overs = oversForFormat(format);
  return Math.ceil(overs / 5) * 6; // T20 → 4 overs, ODI → 10 overs
}

/** Pick the next bowler: prefer real bowlers with quota left, avoid back-to-back overs. */
function chooseBowler(bowlingSquad, meta, maxBalls, currentBowlerId) {
  const realBowlers = bowlingSquad.filter((p) => ['BOWLER', 'ALL_ROUNDER'].includes(p.role));
  const candidates = realBowlers.length ? realBowlers : bowlingSquad;

  let eligible = candidates.filter(
    (p) => (meta.bowlerBalls[p.id] || 0) < maxBalls && p.id !== currentBowlerId
  );
  if (!eligible.length) eligible = candidates.filter((p) => p.id !== currentBowlerId);
  if (!eligible.length) eligible = candidates;
  return pickRandom(eligible).id;
}

/**
 * The autoplay core. Simulates deliveries per `mode`, flushes once,
 * recalcs once, and auto-completes the match if innings 2 ends.
 * Returns a summary the admin UI can toast.
 */
async function playBalls(matchId, mode) {
  const spec = MODES[mode];
  if (!spec) throw new AppError(400, 'BAD_MODE', `mode must be one of ${Object.keys(MODES).join(', ')}`);

  const { match, squad, shorts } = await loadMatchAndSquads(matchId);
  if (match.external_id != null) {
    throw new AppError(400, 'EXTERNAL_MATCH',
      'Autoplay only works on manual/simulator matches — this fixture is driven by Sportmonks');
  }
  if (match.status !== 'LIVE') {
    throw new AppError(400, 'NOT_LIVE', 'Match must be LIVE to simulate play');
  }

  let stRow = await initState(matchId); // lazy-creates for matches started pre-upgrade
  if (stRow.finished) {
    throw new AppError(400, 'MATCH_FINISHED', stRow.result || 'This match has already been played out');
  }

  const ballsPerInnings = oversForFormat(match.format) * 6;
  const maxBowlerBalls = maxBallsPerBowler(match.format);

  // ---- working state, fully in memory ----
  const ws = {
    innings: stRow.innings,
    battingTeamId: stRow.batting_team_id,
    bowlingTeamId: stRow.bowling_team_id,
    runs: stRow.runs,
    wickets: stRow.wickets,
    legalBalls: stRow.legal_balls,
    target: stRow.target,
    innings1: stRow.innings1_runs == null ? null : {
      runs: stRow.innings1_runs, wickets: stRow.innings1_wickets, balls: stRow.innings1_balls,
    },
    strikerId: stRow.striker_id,
    nonStrikerId: stRow.non_striker_id,
    bowlerId: stRow.bowler_id,
    finished: false,
    result: null,
    meta: parseMeta(stRow.meta),
  };
  ws.meta.orders = ws.meta.orders || {};
  ws.meta.dismissed = ws.meta.dismissed || [];
  ws.meta.bowlerBalls = ws.meta.bowlerBalls || {};

  const deltas = new Map(); // playerId -> stat increments
  const delta = (pid) => {
    if (!deltas.has(pid)) {
      deltas.set(pid, { runs: 0, balls_faced: 0, fours: 0, sixes: 0, wickets: 0,
                        balls_bowled: 0, runs_conceded: 0, catches: 0, stumpings: 0 });
    }
    return deltas.get(pid);
  };
  const events = []; // [batsmanId, type, value, metaObj]

  const battersOf = (teamId) => ws.meta.orders[teamId] || [];
  /** On-field players = squad members that made the XI (legacy rows: order == full squad). */
  const xi = (teamId) => {
    const ids = new Set(battersOf(teamId));
    const onField = squad(teamId).filter((p) => ids.has(p.id));
    return onField.length ? onField : squad(teamId);
  };
  const nextBatter = () => {
    const order = battersOf(ws.battingTeamId);
    return order.find(
      (id) => !ws.meta.dismissed.includes(id) && id !== ws.strikerId && id !== ws.nonStrikerId
    ) ?? null;
  };
  const swapStrike = () => { [ws.strikerId, ws.nonStrikerId] = [ws.nonStrikerId, ws.strikerId]; };

  const keeperOf = (teamId) => {
    const wk = xi(teamId).find((p) => p.role === 'WICKET_KEEPER');
    return wk ? wk.id : null;
  };

  const finishMatch = () => {
    ws.finished = true;
    const chasingShort = shorts[ws.battingTeamId];
    const defendingShort = shorts[ws.bowlingTeamId];
    if (ws.target != null && ws.runs >= ws.target) {
      const inHand = battersOf(ws.battingTeamId).length - 1 - ws.wickets;
      ws.result = `${chasingShort} won by ${inHand} wicket${inHand === 1 ? '' : 's'}`;
    } else {
      const margin = (ws.target - 1) - ws.runs;
      ws.result = margin === 0 ? 'Match tied'
        : `${defendingShort} won by ${margin} run${margin === 1 ? '' : 's'}`;
    }
  };

  const endInnings = () => {
    if (ws.innings === 1) {
      ws.innings1 = { runs: ws.runs, wickets: ws.wickets, balls: ws.legalBalls };
      ws.innings = 2;
      ws.target = ws.innings1.runs + 1;
      [ws.battingTeamId, ws.bowlingTeamId] = [ws.bowlingTeamId, ws.battingTeamId];
      ws.runs = 0; ws.wickets = 0; ws.legalBalls = 0;
      ws.meta.bowlerBalls = {};
      ws.meta.lastBowlerId = null;
      const order = battersOf(ws.battingTeamId);
      ws.strikerId = order[0];
      ws.nonStrikerId = order[1];
      ws.bowlerId = chooseBowler(xi(ws.bowlingTeamId), ws.meta, maxBowlerBalls, null);
    } else {
      finishMatch(); // innings 2 ran out of overs/wickets without reaching the target
    }
  };

  const playOneBall = () => {
    const striker = ws.strikerId;
    const bowler = ws.bowlerId;
    const outcome = pickWeighted(EVENT_WEIGHTS);
    const evMeta = {
      bowler,
      innings: ws.innings,
      over: Math.floor(ws.legalBalls / 6),
      ball: (ws.legalBalls % 6) + 1,
    };

    const db = delta(striker);
    const dw = delta(bowler);
    db.balls_faced += 1;
    dw.balls_bowled += 1;

    if (outcome.runs > 0) {
      db.runs += outcome.runs;
      dw.runs_conceded += outcome.runs;
      ws.runs += outcome.runs;
      if (outcome.runs === 4) db.fours += 1;
      if (outcome.runs === 6) db.sixes += 1;
    }

    let inningsOver = false;
    if (outcome.type === 'WICKET') {
      dw.wickets += 1;
      ws.wickets += 1;
      const r = Math.random();
      const keeper = keeperOf(ws.bowlingTeamId);
      if (r < 0.55) {
        const fielders = xi(ws.bowlingTeamId).filter((p) => p.id !== bowler);
        const f = fielders.length ? pickRandom(fielders) : null;
        if (f) { delta(f.id).catches += 1; evMeta.fielder = f.id; evMeta.how = 'CAUGHT'; }
        else evMeta.how = 'BOWLED';
      } else if (r < 0.67 && keeper && keeper !== striker) {
        delta(keeper).stumpings += 1;
        evMeta.fielder = keeper;
        evMeta.how = 'STUMPED';
      } else {
        evMeta.how = 'BOWLED';
      }
      ws.meta.dismissed.push(striker);
    }

    events.push([striker, outcome.type, outcome.runs, evMeta]);

    // Legal delivery bookkeeping
    ws.legalBalls += 1;
    ws.meta.bowlerBalls[bowler] = (ws.meta.bowlerBalls[bowler] || 0) + 1;

    // Strike rotation on odd runs
    if (outcome.runs % 2 === 1) swapStrike();

    // Bring in the next batter (or fold the innings if none remain)
    if (outcome.type === 'WICKET') {
      const next = nextBatter();
      if (next == null) inningsOver = true;
      else ws.strikerId = next;
    }

    // Target chased mid-over?
    if (!inningsOver && ws.innings === 2 && ws.target != null && ws.runs >= ws.target) {
      finishMatch();
      return;
    }

    // Overs exhausted?
    if (!inningsOver && ws.legalBalls >= ballsPerInnings) inningsOver = true;

    if (inningsOver) { endInnings(); return; }

    // Over boundary: rotate strike + change bowler
    if (ws.legalBalls % 6 === 0) {
      swapStrike();
      ws.meta.lastBowlerId = ws.bowlerId;
      ws.bowlerId = chooseBowler(xi(ws.bowlingTeamId), ws.meta, maxBowlerBalls, ws.bowlerId);
    }
  };

  // ---- simulate ----
  const startInnings = ws.innings;
  const maxBalls = spec.balls ?? Infinity;
  let ballsPlayed = 0;
  while (!ws.finished && ballsPlayed < maxBalls) {
    if (spec.untilInningsEnd && ws.innings !== startInnings) break;
    playOneBall();
    ballsPlayed += 1;
  }

  // ---- flush everything in one transaction ----
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const [pid, d] of deltas) {
      await conn.query(
        'INSERT IGNORE INTO player_match_stats (match_id, player_id) VALUES (?, ?)',
        [matchId, pid]
      );
      await conn.query(
        `UPDATE player_match_stats
            SET runs = runs + ?, balls_faced = balls_faced + ?, fours = fours + ?,
                sixes = sixes + ?, wickets = wickets + ?, balls_bowled = balls_bowled + ?,
                runs_conceded = runs_conceded + ?, catches = catches + ?, stumpings = stumpings + ?
          WHERE match_id = ? AND player_id = ?`,
        [d.runs, d.balls_faced, d.fours, d.sixes, d.wickets, d.balls_bowled,
         d.runs_conceded, d.catches, d.stumpings, matchId, pid]
      );
    }

    if (events.length) {
      await conn.query(
        'INSERT INTO match_events (match_id, player_id, event_type, value, meta) VALUES ?',
        [events.map(([pid, type, value, meta]) => [matchId, pid, type, value, JSON.stringify(meta)])]
      );
    }

    await conn.query(
      `UPDATE match_state
          SET innings = ?, batting_team_id = ?, bowling_team_id = ?, runs = ?, wickets = ?,
              legal_balls = ?, target = ?, innings1_runs = ?, innings1_wickets = ?,
              innings1_balls = ?, striker_id = ?, non_striker_id = ?, bowler_id = ?,
              finished = ?, result = ?, meta = ?
        WHERE match_id = ?`,
      [ws.innings, ws.battingTeamId, ws.bowlingTeamId, ws.runs, ws.wickets,
       ws.legalBalls, ws.target,
       ws.innings1 ? ws.innings1.runs : null,
       ws.innings1 ? ws.innings1.wickets : null,
       ws.innings1 ? ws.innings1.balls : null,
       ws.strikerId, ws.nonStrikerId, ws.bowlerId,
       ws.finished ? 1 : 0, ws.result, JSON.stringify(ws.meta), matchId]
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  // ---- fantasy points: recompute ONCE for the whole match ----
  const [statRows] = await pool.query(
    'SELECT * FROM player_match_stats WHERE match_id = ?', [matchId]
  );
  for (const s of statRows) {
    const pts = calcPoints(s);
    if (pts !== Number(s.points)) {
      await pool.query(
        'UPDATE player_match_stats SET points = ? WHERE match_id = ? AND player_id = ?',
        [pts, matchId, s.player_id]
      );
    }
  }
  await recalcAllForMatch(matchId);

  // ---- ball/over prediction resolution for the batch just played ----
  // Lazy require avoids adding a hard dependency to every engine import.
  try {
    await require('./prediction.service').resolveEngineEvents(matchId, events);
  } catch (e) {
    console.error(`[engine] prediction resolution failed for match ${matchId}:`, e.message);
  }

  // ---- natural completion ----
  let completed = false;
  if (ws.finished) {
    try {
      await lifecycle.completeMatch(matchId);
      completed = true;
    } catch (e) {
      if (e.code !== 'CANNOT_COMPLETE') throw e; // already completed elsewhere → fine
    }
  }

  const battingShort = shorts[ws.battingTeamId];
  const scoreline = ws.finished
    ? ws.result
    : `${battingShort} ${ws.runs}/${ws.wickets} (${fmtOvers(ws.legalBalls)} ov)`
      + (ws.innings === 2 ? ` · target ${ws.target}` : '');

  return {
    mode,
    ballsPlayed,
    innings: ws.innings,
    battingTeam: battingShort,
    runs: ws.runs,
    wickets: ws.wickets,
    overs: fmtOvers(ws.legalBalls),
    target: ws.target,
    finished: ws.finished,
    completed,
    result: ws.result,
    scoreline,
  };
}

/**
 * One ball on every LIVE, non-external match. Used by the legacy interval
 * simulator so auto-ticking now also respects innings/over structure.
 */
async function tickAllLiveOneBall() {
  const [rows] = await pool.query(
    `SELECT id FROM matches WHERE status = 'LIVE' AND external_id IS NULL`
  );
  for (const r of rows) {
    try {
      await playBalls(r.id, 'BALL_1');
    } catch (e) {
      if (e.code !== 'MATCH_FINISHED' && e.code !== 'NOT_LIVE') {
        console.error(`[engine] match ${r.id} tick failed:`, e.message);
      }
    }
  }
}

module.exports = { initState, playBalls, tickAllLiveOneBall, oversForFormat, MODES };
