const router = require('express').Router();
const { body } = require('express-validator');
const auth = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const ctrl = require('../controllers/auth.controller');

router.post(
  '/register',
  [
    body('username').isString().trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
    body('password').isString().isLength({ min: 6, max: 100 }),
    body('displayName').optional().isString().trim().isLength({ min: 1, max: 100 }),
    body('avatarUrl').optional({ nullable: true }).isString().isLength({ max: 500 }),
  ],
  validate,
  ctrl.register
);

router.post(
  '/login',
  [
    body('username').isString().trim().notEmpty(),
    body('password').isString().notEmpty(),
  ],
  validate,
  ctrl.login
);

router.get('/me', auth, ctrl.me);

router.patch(
  '/me',
  auth,
  [
    body('displayName').optional().isString().trim().isLength({ min: 1, max: 100 }),
    body('avatarUrl').optional({ nullable: true }).isString().isLength({ max: 500 }),
  ],
  validate,
  ctrl.updateProfile
);

module.exports = router;
