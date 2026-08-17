/**
 * Clean demo matches and import live + scheduled fixtures from RapidAPI.
 *
 *   node scripts/rapidapiSync.js --clean --limit 10
 *   npm run rapidapi:sync -- --clean --limit 10
 */
const { syncFixtures, clearMatches } = require('../src/services/rapidapi.service');

function parseArgs(argv) {
  const opts = { clean: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--clean') opts.clean = true;
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) opts.limit = Number(a.split('=')[1]);
  }
  return opts;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.clean) await clearMatches();
  await syncFixtures({ limit: opts.limit });
  process.exit(0);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
