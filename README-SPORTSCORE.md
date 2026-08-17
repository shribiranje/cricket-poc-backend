# SportScore Integration (DATA_SOURCE=SPORTSCORE)

Adds sportscore.com's free public API as a fourth data source alongside
SIMULATOR / SPORTMONKS / RAPIDAPI. No API key required.

## What was added

| File | Purpose |
|---|---|
| `db/migrations/005_sportscore.sql` | `external_slug` columns on teams/players/matches (SportScore uses string slugs; existing `external_id` BIGINT columns stay untouched for SportMonks) |
| `scripts/sportscoreProbe.js` | Dumps real cricket payloads to `probe-output/` — **run this first** |
| `src/services/sportscore.service.js` | Live poller: `start()/stop()/tickOnce()`, budget guard, ADJUST-marked mappers |
| `src/utils/sportscoreSync.js` | Fixture/lineup discovery CLI → teams, players, matches, match_players |
| `src/config/index.js` | `sportscore` config block |
| `server.js` | `DATA_SOURCE=SPORTSCORE` wiring |
| frontend `app.component.ts` + environments | Required "Powered by SportScore" attribution footer (flag: `sportScoreAttribution`) |

## Setup

```bash
cd backend
npm run db:migrate:sportscore     # adds external_slug columns
npm run sportscore:probe          # ← DO NOT SKIP. See "Decision gate" below.
# inspect backend/probe-output/sportscore-*.json, fix ADJUST mappers if needed
npm run sportscore:sync -- --limit 3
# .env: DATA_SOURCE=SPORTSCORE
npm start
```

Frontend: set `sportScoreAttribution: true` in the environment file(s) you build
with — the free-tier terms require the visible "Powered by SportScore" link on
any page showing their data.

## ⚠ Decision gate — read before going live

SportScore's API is a **generic live-scores API** (8 endpoints shared across
football/basketball/cricket/tennis; football-first). Its docs describe match
detail as "score, status, timeline, lineups" — the exact cricket payload shape
is **not documented**, and specifically it is **unconfirmed whether a
per-player batting/bowling scorecard exists**.

The fantasy scoring engine (`scoring.service.js`) needs, per player per match:
`runs, balls_faced, fours, sixes, wickets, balls_bowled, runs_conceded,
catches, run_outs, stumpings`.

The probe script tells you which world you're in:

- **Probe shows per-player scorecard data** → finalize the three
  ADJUST-marked extractors in `sportscore.service.js` (and the field helpers in
  `sportscoreSync.js`) against the real field names, and you're good.
- **Probe shows only team score + lineups** → SportScore can manage match
  lifecycle (UPCOMING→LIVE→COMPLETED, team lock) but **cannot produce fantasy
  points** — every player scores 0. The service logs a one-time warning if this
  happens at runtime. In that case keep SPORTMONKS or RAPIDAPI as the scoring
  source. If your original problem was *coverage* (SportMonks missing matches),
  the better fixes are: (a) upgrading the SportMonks plan / league entitlements,
  (b) a dedicated cricket API with full scorecards (e.g. the RapidAPI
  Cricbuzz-derived source already integrated, EntitySport, or Roanuz Cricket
  API), or (c) a hybrid — SportScore for fixture discovery of missing matches +
  a scorecard-capable source for scoring.

## Hard constraints (free tier)

- **~1000 requests / 24h / IP**, with 60-second edge caching upstream. The
  poller enforces a 60s minimum interval and a rolling 24h budget
  (`SPORTSCORE_DAILY_BUDGET`, default 900).
- **Budget math:** 1 live match ≈ 1440 req/day at 60s polling — already over
  budget. The budget guard will halt polling partway through a second match's
  day. This tier is realistic for demos or a single match window, **not** for
  production with concurrent matches. Commercial volume: api@sportscore.com.
- **Attribution** is contractual on the free tier — don't ship with the footer
  flag off while `DATA_SOURCE=SPORTSCORE`.

## Env vars

```
DATA_SOURCE=SPORTSCORE
SPORTSCORE_BASE_URL=https://sportscore.com
SPORTSCORE_POLL_LIVE_MS=60000     # clamped to >= 60000 in code
SPORTSCORE_DAILY_BUDGET=900
```
