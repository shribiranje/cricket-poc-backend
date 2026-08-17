/**
 * List Sportmonks leagues available on your plan.
 * Useful for figuring out which league_id to pass to `sportmonks:sync --league <id>`.
 *
 * Usage:  npm run sportmonks:leagues
 */
const config = require('../config');
const { smFetch } = require('../services/sportmonks.service');

async function main() {
  if (!config.sportmonks.apiToken) {
    console.error('SPORTMONKS_API_TOKEN not set. Edit backend/.env');
    process.exit(1);
  }

  console.log('Fetching leagues on your plan…\n');
  const res = await smFetch('/leagues', {});
  const leagues = res.data || [];
  if (!leagues.length) {
    console.log('No leagues returned (or empty page).');
    process.exit(0);
  }

  // Pretty print
  console.log('ID     Code   Name');
  console.log('----   -----  --------------------------------');
  for (const l of leagues) {
    const id = String(l.id).padEnd(6);
    const code = String(l.code || '').padEnd(6);
    console.log(`${id} ${code} ${l.name}`);
  }
  console.log(`\n${leagues.length} leagues total.`);
  console.log('\nUse a league ID like:  npm run sportmonks:sync -- --league <id>');
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed:', e.message || e);
  process.exit(1);
});
