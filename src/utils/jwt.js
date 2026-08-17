const jwt = require('jsonwebtoken');
const config = require('../config');

exports.sign = (payload) =>
  jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

exports.verify = (token) => jwt.verify(token, config.jwt.secret);
