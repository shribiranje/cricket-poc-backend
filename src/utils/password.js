const bcrypt = require('bcryptjs');

exports.hash = (plain) => bcrypt.hash(plain, 10);
exports.compare = (plain, hashed) => bcrypt.compare(plain, hashed);
