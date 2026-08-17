const pool = require('../config/db');
const { verify } = require('../utils/jwt');
const { fail } = require('../utils/response');

module.exports = async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return fail(res, 401, 'UNAUTHORIZED', 'Missing bearer token');
  }
  try {
    const payload = verify(header.slice(7));
    // Re-read from DB rather than trusting token so revocation is instant
    const [[user]] = await pool.query(
      'SELECT id, username, is_admin FROM users WHERE id = ?',
      [payload.sub]
    );
    if (!user) return fail(res, 401, 'INVALID_TOKEN', 'User no longer exists');
    if (!user.is_admin) return fail(res, 403, 'FORBIDDEN', 'Admin access required');
    req.userId = user.id;
    req.username = user.username;
    req.isAdmin = true;
    next();
  } catch (e) {
    return fail(res, 401, 'INVALID_TOKEN', 'Token invalid or expired');
  }
};
