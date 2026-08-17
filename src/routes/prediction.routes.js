const router = require('express').Router();
const { body, query } = require('express-validator');
const auth = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const ctrl = require('../controllers/prediction.controller');

router.get('/predictions/wallet', auth, ctrl.wallet);
router.post('/predictions/wallet/buy',
  auth,
  [body('amount').isInt({ min: 1 })],
  validate,
  ctrl.buyPoints);
router.get('/predictions/transactions',
  auth,
  [
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  validate,
  ctrl.transactions);
router.get('/predictions/bets',
  auth,
  [
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
    query('status').optional().isIn(['OPEN', 'WON', 'LOST', 'VOID']),
  ],
  validate,
  ctrl.bets);
router.get('/predictions/analytics', auth, ctrl.analytics);

router.get('/matches/:matchId/progress', auth, ctrl.progress);
router.post('/matches/:matchId/predictions', auth, ctrl.place);
router.get('/matches/:matchId/predictions/mine', auth, ctrl.mine);
router.get('/matches/:matchId/predictions/leaderboard', auth, ctrl.leaderboard);

module.exports = router;
