const router = require('express').Router();
const auth = require('../middlewares/auth');
const history = require('../controllers/history.controller');

router.get('/', auth, history.list);

module.exports = router;
