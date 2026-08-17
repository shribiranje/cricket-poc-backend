/**
 * One-shot DB initializer:
 *  - schema.sql  → DDL only (from poc_v1.sql)
 *  - seed.sql    → reference catalog (teams/players/matches/match_players)
 *                  applied only when DATA_SOURCE=SIMULATOR
 *  - demo users  → bcrypt hashes for demo/alice/bob (password: password123)
 *
 * For Sportmonks mode:
 *   npm run db:init                # creates schema + users only
 *   npm run sportmonks:sync         # then pulls real fixtures/teams/players
 *
 * Source dumps: poc_v1.sql (base) + poc_v2.sql (timezone/auto_start/match_state).
 * Re-split into backend/db/schema.sql + seed.sql; for existing DBs also see
 * backend/db/migrations/003_match_admin.sql.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');
const { hash } = require('./password');

const dbDir = path.join(__dirname, '../../db');

async function run() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });

  console.log('→ Applying schema.sql (DDL)');
  await conn.query(fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));

  // Upgrade path for volumes created before timezone/auto_start/match_state existed.
  // Fresh installs are a no-op (columns/table already present via schema.sql).
  const migration = path.join(dbDir, 'migrations', '003_match_admin.sql');
  if (fs.existsSync(migration)) {
    console.log('→ Applying migrations/003_match_admin.sql (idempotent)');
    await conn.query(fs.readFileSync(migration, 'utf8'));
  }

  if (config.dataSource === 'SIMULATOR') {
    console.log('→ Applying seed.sql (teams / players / matches / lineups)');
    await conn.query(fs.readFileSync(path.join(dbDir, 'seed.sql'), 'utf8'));
  } else {
    console.log('→ Skipping seed.sql (DATA_SOURCE=SPORTMONKS)');
    console.log('  Run `npm run sportmonks:sync` to pull real fixtures.');
  }

  console.log('→ Ensuring demo users (demo/alice/bob, password: password123; demo is admin)');
  await conn.query(`USE \`${config.db.database}\``);
  const pw = await hash('password123');
  const demoUsers = [
    ['demo',  'Demo User', 1],
    ['alice', 'Alice',     0],
    ['bob',   'Bob',       0],
  ];
  for (const [u, dn, admin] of demoUsers) {
    await conn.query(
      'INSERT IGNORE INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)',
      [u, pw, dn, admin]
    );
  }

  await conn.end();
  console.log('✓ DB initialized');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
