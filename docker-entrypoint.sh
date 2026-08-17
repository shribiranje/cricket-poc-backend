#!/bin/sh
set -e

echo "[entrypoint] waiting for MySQL at ${DB_HOST:-mysql}:${DB_PORT:-3306}…"
i=0
until node -e "
const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || 'mysql',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });
  await c.ping();
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] MySQL not ready after 60s" >&2
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] MySQL is up"

if [ "${AUTO_DB_INIT:-true}" = "true" ]; then
  echo "[entrypoint] running db:init"
  node src/utils/dbInit.js || {
    echo "[entrypoint] db:init failed" >&2
    exit 1
  }
fi

exec "$@"
