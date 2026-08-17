const { validationResult } = require('express-validator');
const { fail } = require('../utils/response');

module.exports = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  return fail(
    res,
    400,
    'VALIDATION_ERROR',
    'Invalid request payload',
    errors.array().map((e) => ({ field: e.path, msg: e.msg }))
  );
};
