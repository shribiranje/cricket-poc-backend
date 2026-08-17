/**
 * Run a multi-statement SQL migration file from backend/db/migrations/.
 * Usage: node src/utils/runMigration.js 003_match_admin.sql
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

async function run() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node src/utils/runMigration.js <file.sql>');
    process.exit(1);
  }
  const file = path.join(__dirname, '../../db/migrations', name);
  if (!fs.existsSync(file)) {
    console.error(`Migration not found: ${file}`);
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  console.log(`→ Applying ${name}`);
  await conn.query(fs.readFileSync(file, 'utf8'));
  await conn.end();
  console.log('✓ Migration applied');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
