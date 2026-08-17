const router = require('express').Router();
const { param, body, query } = require('express-validator');
const adminAuth = require('../middlewares/adminAuth');
const validate = require('../middlewares/validate');
const { ok, AppError } = require('../utils/response');
const simulator = require('../services/simulator.service');
const sportmonks = require('../services/sportmonks.service');
const rapidapi = require('../services/rapidapi.service');
const config = require('../config');
const lifecycle = require('../services/matchLifecycle.service');
const engine = require('../services/matchEngine.service');
const admin = require('../controllers/admin.controller');

// All /admin routes require admin auth
router.use(adminAuth);

const activeDataService = () =>
  config.dataSource === 'SPORTMONKS' ? sportmonks : simulator;

// ---------- Dashboard ----------
router.get('/stats',    admin.stats);
router.get('/matches',  admin.listMatches);
router.get('/users',    admin.listUsers);
router.get('/teams',    admin.listTeams);

// ---------- User admin ----------
router.post('/users',
  [
    body('username').isString().trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/)
      .withMessage('username must be 3-50 chars: letters, numbers, underscore'),
    body('password').isString().isLength({ min: 6, max: 100 }),
    body('displayName').optional().isString().trim().isLength({ min: 1, max: 100 }),
    body('avatarUrl').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('isAdmin').optional().isBoolean(),
  ],
  validate, admin.createUser);

router.patch('/users/:id',
  [
    param('id').isInt(),
    body('username').optional().isString().trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
    body('password').optional().isString().isLength({ min: 6, max: 100 }),
    body('displayName').optional().isString().trim().isLength({ min: 1, max: 100 }),
    body('avatarUrl').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('isAdmin').optional().isBoolean(),
  ],
  validate, admin.updateUser);

router.patch('/users/:id/admin',
  [param('id').isInt(), body('isAdmin').isBoolean()],
  validate, admin.setAdmin);

// ---------- Manual match CRUD ----------
router.post('/matches',
  [
    body('teamAId').isInt(),
    body('teamBId').isInt(),
    body('format').optional().isString().isLength({ max: 20 }),
    body('venue').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('startTimeUtc').isISO8601().withMessage('startTimeUtc must be an ISO-8601 datetime'),
    body('timezone').optional().isString().isLength({ max: 64 }),
    body('autoStart').optional().isBoolean(),
  ],
  validate, admin.createMatch);

router.patch('/matches/:id',
  [
    param('id').isInt(),
    body('teamAId').optional().isInt(),
    body('teamBId').optional().isInt(),
    body('format').optional().isString().isLength({ max: 20 }),
    body('venue').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('startTimeUtc').optional().isISO8601(),
    body('timezone').optional().isString().isLength({ max: 64 }),
    body('autoStart').optional().isBoolean(),
  ],
  validate, admin.updateMatch);

router.delete('/matches/:id', [param('id').isInt()], validate, admin.deleteMatch);

// ---------- Match lifecycle ----------
router.post('/matches/:id/start', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    return ok(res, await lifecycle.startMatch(Number(req.params.id)));
  } catch (e) { next(e); }
});

router.post('/matches/:id/complete', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    return ok(res, await lifecycle.completeMatch(Number(req.params.id)));
  } catch (e) { next(e); }
});

router.post('/matches/:id/reset',
  [param('id').isInt()], validate, admin.resetMatch);

// ---------- Autoplay (instant) ----------
// mode: BALL_1 | OVER_1 | OVER_5 | INNINGS | END_MATCH
router.post('/matches/:id/autoplay',
  [param('id').isInt(), body('mode').isIn(Object.keys(engine.MODES))],
  validate, async (req, res, next) => {
    try {
      return ok(res, await engine.playBalls(Number(req.params.id), req.body.mode));
    } catch (e) { next(e); }
  });

// ---------- Simulator ----------
router.post('/simulator/tick', async (req, res, next) => {
  try {
    await activeDataService().tickOnce();
    return ok(res, { ticked: true, source: config.dataSource });
  } catch (e) { next(e); }
});

// ---------- RapidAPI ----------
router.post('/rapidapi/sync-status', async (req, res, next) => {
  try {
    if (config.dataSource !== 'RAPIDAPI') {
      throw new AppError(400, 'WRONG_SOURCE',
        `DATA_SOURCE is ${config.dataSource} — switch to RAPIDAPI to sync live statuses`);
    }
    return ok(res, await rapidapi.syncStatuses());
  } catch (e) { next(e); }
});

/** Import fixtures (same as `npm run rapidapi:sync -- --clean --limit 10`). */
router.post('/rapidapi/sync-fixtures',
  [
    body('clean').optional().isBoolean(),
    body('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      if (config.dataSource !== 'RAPIDAPI') {
        throw new AppError(400, 'WRONG_SOURCE',
          `DATA_SOURCE is ${config.dataSource} — switch to RAPIDAPI to import fixtures`);
      }
      const clean = req.body.clean !== false; // default true (matches usual CLI usage)
      const limit = req.body.limit != null ? Number(req.body.limit) : undefined;
      return ok(res, await rapidapi.syncFixturesAdmin({ clean, limit }));
    } catch (e) { next(e); }
  });

router.get('/rapidapi/poll/status', async (req, res, next) => {
  try {
    if (config.dataSource !== 'RAPIDAPI') {
      throw new AppError(400, 'WRONG_SOURCE',
        `DATA_SOURCE is ${config.dataSource} — switch to RAPIDAPI for timed poll`);
    }
    return ok(res, await rapidapi.getPollStatus());
  } catch (e) { next(e); }
});

router.post('/rapidapi/poll/start',
  [body('durationMinutes').isIn([15, 60, 120])],
  validate,
  async (req, res, next) => {
    try {
      if (config.dataSource !== 'RAPIDAPI') {
        throw new AppError(400, 'WRONG_SOURCE',
          `DATA_SOURCE is ${config.dataSource} — switch to RAPIDAPI for timed poll`);
      }
      return ok(res, await rapidapi.startPollSession(
        Number(req.body.durationMinutes),
        req.userId
      ));
    } catch (e) { next(e); }
  });

router.post('/rapidapi/poll/stop', async (req, res, next) => {
  try {
    if (config.dataSource !== 'RAPIDAPI') {
      throw new AppError(400, 'WRONG_SOURCE',
        `DATA_SOURCE is ${config.dataSource} — switch to RAPIDAPI for timed poll`);
    }
    return ok(res, await rapidapi.stopPollSession());
  } catch (e) { next(e); }
});

/** Admin-editable RapidAPI poll/sync settings (persisted in app_settings). */
router.get('/rapidapi/settings', async (req, res, next) => {
  try {
    return ok(res, await rapidapi.getSettings());
  } catch (e) { next(e); }
});

router.put('/rapidapi/settings',
  [
    body('pollLiveMs').optional().isInt({ min: 60000, max: 300000 }),
    body('minGapMs').optional().isInt({ min: 0, max: 30000 }),
    body('scorecardEveryN').optional().isInt({ min: 1, max: 20 }),
    body('syncFixtureLimit').optional().isInt({ min: 1, max: 50 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      return ok(res, await rapidapi.updateSettings(req.body));
    } catch (e) { next(e); }
  });

/** Per-call RapidAPI analytics log (local DB). */
router.get('/rapidapi/analytics',
  [
    query('limit').optional().isInt({ min: 1, max: 500 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      return ok(res, await rapidapi.getCallAnalytics({
        limit: req.query.limit != null ? Number(req.query.limit) : 100,
        offset: req.query.offset != null ? Number(req.query.offset) : 0,
      }));
    } catch (e) { next(e); }
  });

module.exports = router;
