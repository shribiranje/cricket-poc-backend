const pool = require('../config/db');
const { hash, compare } = require('../utils/password');
const { sign } = require('../utils/jwt');
const { ok, AppError } = require('../utils/response');

const publicUser = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
  isAdmin: !!row.is_admin,
  joinDate: row.created_at,
});

exports.register = async (req, res, next) => {
  try {
    const { username, password, displayName, avatarUrl } = req.body;
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length) throw new AppError(409, 'USERNAME_TAKEN', 'Username already exists');

    const password_hash = await hash(password);
    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash, display_name, avatar_url) VALUES (?, ?, ?, ?)',
      [username, password_hash, displayName || username, avatarUrl || null]
    );
    const [[row]] = await pool.query(
      'SELECT id, username, display_name, avatar_url, is_admin, created_at FROM users WHERE id = ?',
      [result.insertId]
    );
    const token = sign({ sub: row.id, username: row.username, isAdmin: !!row.is_admin });
    return ok(res, { token, user: publicUser(row) }, 201);
  } catch (e) { next(e); }
};

exports.login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const [rows] = await pool.query(
      'SELECT id, username, password_hash, display_name, avatar_url, is_admin, created_at FROM users WHERE username = ?',
      [username]
    );
    if (!rows.length) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    const user = rows[0];
    const okPw = await compare(password, user.password_hash);
    if (!okPw) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');

    const token = sign({ sub: user.id, username: user.username, isAdmin: !!user.is_admin });
    return ok(res, { token, user: publicUser(user) });
  } catch (e) { next(e); }
};

exports.me = async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, username, display_name, avatar_url, is_admin, created_at FROM users WHERE id = ?',
      [req.userId]
    );
    if (!rows.length) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    return ok(res, publicUser(rows[0]));
  } catch (e) { next(e); }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const { displayName, avatarUrl } = req.body;
    await pool.query(
      'UPDATE users SET display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?',
      [displayName || null, avatarUrl || null, req.userId]
    );
    return exports.me(req, res, next);
  } catch (e) { next(e); }
};
