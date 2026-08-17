const { AppError, fail } = require('../utils/response');

// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  if (err instanceof AppError) {
    return fail(res, err.status, err.code, err.message, err.details);
  }
  console.error('[UNHANDLED]', err);
  return fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
};
