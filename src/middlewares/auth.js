const { verify } = require('../utils/jwt');
const { fail } = require('../utils/response');

module.exports = (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return fail(res, 401, 'UNAUTHORIZED', 'Missing bearer token');
  }
  try {
    const payload = verify(header.slice(7));
    req.userId = payload.sub;
    req.username = payload.username;
    next();
  } catch (e) {
    return fail(res, 401, 'INVALID_TOKEN', 'Token invalid or expired');
  }
};
