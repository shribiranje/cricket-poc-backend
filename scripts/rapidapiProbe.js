/**
 * One-shot RapidAPI endpoint prober.
 *   node scripts/rapidapiProbe.js [externalMatchId]
 * Dumps raw JSON from each configured endpoint into ./probe-output so the
 * mapper functions in rapidapi.service.js can be finalized against real
 * payloads. Rerun with a match id (from live/fixtures output) to also probe
 * the scorecard + commentary endpoints.
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const C = config.rapidapi;

async function hit(name, ep, params) {
  const url = new URL(C.baseUrl + ep);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, {
      headers: { 'X-RapidAPI-Key': C.key, 'X-RapidAPI-Host': C.host },
    });
    const body = await res.text();
    const out = path.join('probe-output', `${name}-${res.status}.json`);
    fs.writeFileSync(out, body);
    console.log(`${res.ok ? 'OK ' : 'ERR'} ${res.status}  ${ep}  ->  ${out}`);
  } catch (e) {
    console.log(`FAIL       ${ep}  ->  ${e.message}`);
  }
}

(async () => {
  if (!C.key) { console.error('Set RAPIDAPI_KEY in .env first'); process.exit(1); }
  fs.mkdirSync('probe-output', { recursive: true });
  const matchId = process.argv[2];

  await hit('live', C.ep.live);
  await hit('fixtures', C.ep.fixtures);
  if (matchId) {
    await hit('scorecard', C.ep.scorecard, { matchid: matchId });
    await hit('commentary', C.ep.commentary, { matchid: matchId });
  } else {
    console.log('\nTip: rerun with a match id from the live/fixtures output:');
    console.log('     node scripts/rapidapiProbe.js 12345');
  }
  console.log('\n404 on a path? Open the RapidAPI playground for "Cricket API Free');
  console.log('Data", copy the real path into the matching RAPIDAPI_EP_* var in .env,');
  console.log('and rerun. Then share probe-output/*.json to finalize the mappers.');
})();
