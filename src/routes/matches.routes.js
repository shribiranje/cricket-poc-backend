const router = require('express').Router();
const { body, param, query } = require('express-validator');
const auth = require('../middlewares/auth');
const validate = require('../middlewares/validate');

const matches = require('../controllers/matches.controller');
const teams = require('../controllers/teams.controller');
const leaderboard = require('../controllers/leaderboard.controller');
const rapidapi = require('../services/rapidapi.service');
const config = require('../config');
const { ok, AppError } = require('../utils/response');

router.get(
  '/',
  [query('status').optional().isIn(['UPCOMING', 'LIVE', 'COMPLETED', 'upcoming', 'live', 'completed'])],
  validate,
  matches.list
);

router.get('/:id', [param('id').isInt()], validate, matches.detail);
router.get('/:id/players', [param('id').isInt()], validate, matches.players);
router.get('/:id/state', [param('id').isInt()], validate, matches.state);

// Team builder
router.post(
  '/:id/teams',
  auth,
  [
    param('id').isInt(),
    body('playerIds').isArray({ min: 11, max: 11 }).withMessage('playerIds must be an array of 11 ids'),
    body('playerIds.*').isInt(),
    body('captainId').isInt(),
    body('viceCaptainId').isInt(),
  ],
  validate,
  teams.submit
);
router.get('/:id/teams/me', auth, [param('id').isInt()], validate, teams.getMine);

// Leaderboard for the match
router.get('/:id/leaderboard', [param('id').isInt()], validate, leaderboard.forMatch);

// Sync one match for over-betting:
//   RapidAPI external → pull commentary/scorecard (if the product exposes them)
//   Simulator/manual  → play 1 over so open OVER bets can settle (demo path)
router.post('/:id/sync', auth, [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const matchId = Number(req.params.id);
    const pool = require('../config/db');
    const [[m]] = await pool.query(
      'SELECT id, external_id, status FROM matches WHERE id = ?', [matchId]
    );
    if (!m) throw new AppError(404, 'MATCH_NOT_FOUND', 'Match not found');

    if (m.external_id != null) {
      if (config.dataSource !== 'RAPIDAPI') {
        throw new AppError(400, 'WRONG_SOURCE',
          `DATA_SOURCE is ${config.dataSource} — RapidAPI sync unavailable`);
      }
      return ok(res, await rapidapi.syncMatch(matchId));
    }

    // Simulator / manual fixture — advance one over and settle bets
    if (m.status !== 'LIVE') {
      throw new AppError(409, 'MATCH_NOT_LIVE', 'Start the match before syncing an over');
    }
    const engine = require('../services/matchEngine.service');
    const prediction = require('../services/prediction.service');
    const summary = await engine.playBalls(matchId, 'OVER_1');
    const progress = await prediction.getMatchProgress(matchId);
    return ok(res, {
      matchId,
      status: summary.finished ? 'COMPLETED' : 'LIVE',
      started: false,
      scored: true,
      completed: !!summary.finished,
      progress,
      scoreline: summary.scoreline,
    });
  } catch (e) { next(e); }
});

module.exports = router;
