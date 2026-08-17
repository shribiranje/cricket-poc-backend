/**
 * SportScore probe — dump real cricket payloads so we can finalize mappers.
 * ------------------------------------------------------------------------
 * SportScore's OpenAPI spec documents 8 generic endpoints, but the exact
 * CRICKET response shapes (does match detail include a per-player batting/
 * bowling scorecard? what are the field names?) are not documented anywhere.
 * The fantasy scoring engine needs per-player runs/balls/fours/sixes/wickets/
 * balls_bowled/runs_conceded — so RUN THIS FIRST and inspect probe-output/
 * before trusting the SPORTSCORE data source.
 *
 * Usage:
 *   npm run sportscore:probe                        # matches list + first match detail
 *   npm run sportscore:probe -- --slug some-match   # detail for a specific match slug
 *   npm run sportscore:probe -- --player virat-kohli
 *
 * Output: backend/probe-output/sportscore-*.json
 *
 * IMPORTANT — after running, check sportscore-match-detail.json for a
 * per-player scorecard (innings/batting/bowling arrays with numbers per
 * player). If it only contains a team-level score + lineups, SportScore
 * CANNOT drive fantasy scoring and you should keep SPORTMONKS/RAPIDAPI
 * as the scoring source (see README-SPORTSCORE.md, "Decision gate").
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const OUT_DIR = path.join(__dirname, '..', 'probe-output');
const C = config.sportscore;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--slug') out.slug = args[++i];
    else if (args[i] === '--player') out.player = args[++i];
  }
  return out;
}

async function ssFetch(p, query = {}) {
  const url = new URL(C.baseUrl + p);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  console.log(`GET ${url}`);
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': C.userAgent },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SportScore ${res.status} for ${p}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response for ${p}: ${text.slice(0, 200)}`); }
}

function dump(name, data) {
  const file = path.join(OUT_DIR, `sportscore-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`  ↳ wrote ${file}`);
}

/** Best-effort: find "the list of matches" in whatever envelope comes back. */
function extractMatchList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const k of ['matches', 'results', 'data', 'items', 'events']) {
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  return [];
}

/** Best-effort: find a slug-ish identifier on a match object. */
function extractSlug(m) {
  const direct = m?.slug || m?.match_slug || m?.url_slug || m?.id_slug;
  if (direct) return String(direct);
  for (const k of ['url', 'link', 'href', 'match_url', 'permalink', 'web_url']) {
    const v = m?.[k];
    if (typeof v !== 'string') continue;
    const byPath = v.match(/\/match\/([^\/?#]+)/i);
    if (byPath) return byPath[1];
    const trailing = v.replace(/\/+$/, '').split('/').pop();
    if (trailing && /-vs-/i.test(trailing)) return trailing;
  }
  return null;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = parseArgs();

  // 1. Live + recent cricket matches
  const matches = await ssFetch('/api/widget/matches/', { sport: 'cricket', limit: 20 });
  dump('matches', matches);
  const list = extractMatchList(matches);
  console.log(`  parsed ${list.length} matches from envelope`);
  if (list.length) {
    console.log('\n  --- First match object (field-name reference) ---');
    console.log('  keys:', Object.keys(list[0]).join(', '));
    console.log('  ' + JSON.stringify(list[0], null, 2).split('\n').join('\n  '));
  }

  // 2. Match detail — THE critical probe. Look for a per-player scorecard.
  const slug = args.slug || (list.length ? extractSlug(list[0]) : null);
  if (slug) {
    const detail = await ssFetch('/api/widget/match/', { sport: 'cricket', slug });
    dump('match-detail', detail);

    // Quick heuristic report so you don't have to eyeball 500 lines of JSON:
    const json = JSON.stringify(detail).toLowerCase();
    const signals = ['batting', 'bowling', 'innings', 'scorecard', 'balls_faced', 'fours', 'sixes', 'wickets'];
    const found = signals.filter((s) => json.includes(s));
    console.log('\n  --- Scorecard signal check ---');
    console.log(`  Found keys: ${found.length ? found.join(', ') : 'NONE'}`);
    if (found.length >= 3) {
      console.log('  ✓ Looks like per-player cricket data may exist. Finalize the');
      console.log('    ADJUST-marked mappers in src/services/sportscore.service.js.');
    } else {
      console.log('  ✗ No per-player scorecard signals. SportScore likely cannot');
      console.log('    drive fantasy scoring — see README-SPORTSCORE.md "Decision gate".');
    }
  } else {
    console.log('  (no match slug discovered — pass one with --slug)');
  }

  // 3. Player endpoint — check whether stats are per-match or season aggregates
  const playerSlug = args.player || 'virat-kohli';
  try {
    const player = await ssFetch('/api/widget/player/', { sport: 'cricket', slug: playerSlug });
    dump('player', player);
  } catch (e) {
    console.warn(`  player probe failed (${e.message}) — not fatal`);
  }

  // 4. Tracker — README says "usually only useful for football" but worth one look
  const firstId = list.length ? (list[0].id ?? list[0].match_id) : null;
  if (firstId != null) {
    try {
      const tracker = await ssFetch('/api/widget/tracker/', { sport: 'cricket', id: String(firstId) });
      dump('tracker', tracker);
    } catch (e) {
      console.warn(`  tracker probe failed (${e.message}) — not fatal`);
    }
  }

  console.log('\nDone. Inspect backend/probe-output/sportscore-*.json before enabling DATA_SOURCE=SPORTSCORE.');
  process.exit(0);
}

main().catch((e) => { console.error('Probe failed:', e.message || e); process.exit(1); });
