/**
 * Rule-based fantasy points calculator.
 *
 * Standard T20 rules approximation. All values live here so tweaks are one place.
 * Inputs are cumulative player stats for a match (single row from player_match_stats).
 */

const RULES = {
  perRun: 1,
  perFour: 1,          // boundary bonus (in addition to run points)
  perSix: 2,
  fifty: 8,            // 50–99 runs
  hundred: 16,         // 100+
  duckOut: -2,         // non-bowler dismissed for 0 off ≥1 ball
  perWicket: 25,
  threeWickets: 4,
  fourWickets: 8,
  fiveWickets: 16,
  perCatch: 8,
  perRunOut: 12,
  perStumping: 12,
};

function battingPoints(s) {
  let p = 0;
  p += s.runs * RULES.perRun;
  p += s.fours * RULES.perFour;
  p += s.sixes * RULES.perSix;
  if (s.runs >= 100) p += RULES.hundred;
  else if (s.runs >= 50) p += RULES.fifty;

  // strike rate bonus (only if faced ≥ 10 balls)
  if (s.balls_faced >= 10) {
    const sr = (s.runs / s.balls_faced) * 100;
    if (sr > 170) p += 6;
    else if (sr > 150) p += 4;
    else if (sr >= 130) p += 2;
    else if (sr < 50) p -= 6;
    else if (sr < 60) p -= 4;
    else if (sr < 70) p -= 2;
  }
  return p;
}

function bowlingPoints(s) {
  let p = 0;
  p += s.wickets * RULES.perWicket;
  if (s.wickets >= 5) p += RULES.fiveWickets;
  else if (s.wickets >= 4) p += RULES.fourWickets;
  else if (s.wickets >= 3) p += RULES.threeWickets;

  // economy bonus (only if bowled ≥ 12 balls = 2 overs)
  if (s.balls_bowled >= 12) {
    const overs = s.balls_bowled / 6;
    const econ = s.runs_conceded / overs;
    if (econ < 5) p += 6;
    else if (econ < 6) p += 4;
    else if (econ < 7) p += 2;
    else if (econ >= 12) p -= 6;
    else if (econ >= 11) p -= 4;
    else if (econ >= 10) p -= 2;
  }
  return p;
}

function fieldingPoints(s) {
  return s.catches * RULES.perCatch + s.run_outs * RULES.perRunOut + s.stumpings * RULES.perStumping;
}

/**
 * @param {Object} stats — a row from player_match_stats
 * @returns {number} total fantasy points
 */
function calcPoints(stats) {
  const s = {
    runs: +stats.runs || 0,
    balls_faced: +stats.balls_faced || 0,
    fours: +stats.fours || 0,
    sixes: +stats.sixes || 0,
    wickets: +stats.wickets || 0,
    balls_bowled: +stats.balls_bowled || 0,
    runs_conceded: +stats.runs_conceded || 0,
    catches: +stats.catches || 0,
    run_outs: +stats.run_outs || 0,
    stumpings: +stats.stumpings || 0,
  };
  const p = battingPoints(s) + bowlingPoints(s) + fieldingPoints(s);
  return Math.round(p * 100) / 100;
}

module.exports = { calcPoints, RULES };
