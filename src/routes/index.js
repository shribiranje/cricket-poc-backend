const router = require('express').Router();

router.use('/auth', require('./auth.routes'));
router.use('/matches', require('./matches.routes'));
router.use('/history', require('./history.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/', require('./prediction.routes'));

router.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

module.exports = router;
