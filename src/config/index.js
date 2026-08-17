require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');
const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  // corsOrigin: process.env.CORS_ORIGIN || '*',
corsOrigin: (() => {
  const raw = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length <= 1 ? (raw[0] || '*') : raw;
})(),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'fantasy_poc',
    connectionLimit: num(process.env.DB_CONNECTION_LIMIT, 10),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  rules: {
    creditBudget: num(process.env.CREDIT_BUDGET, 100),
    teamSize: num(process.env.TEAM_SIZE, 11),
    minBatsmen: num(process.env.MIN_BATSMEN, 3),
    minBowlers: num(process.env.MIN_BOWLERS, 3),
    minAllRounders: num(process.env.MIN_ALL_ROUNDERS, 1),
    minWicketKeepers: num(process.env.MIN_WICKET_KEEPERS, 1),
    maxPerRole: num(process.env.MAX_PER_ROLE, 8),
    captainMultiplier: num(process.env.CAPTAIN_MULTIPLIER, 2),
    viceCaptainMultiplier: num(process.env.VICE_CAPTAIN_MULTIPLIER, 1.5),
  },

  dataSource: (process.env.DATA_SOURCE || 'SIMULATOR').toUpperCase(),

  scheduler: {
    enabled: bool(process.env.AUTO_START_ENABLED, true),
    pollMs: num(process.env.AUTO_START_POLL_MS, 30000),
  },

  simulator: {
    enabled: bool(process.env.SIMULATOR_ENABLED, true),
    tickMs: num(process.env.SIMULATOR_TICK_MS, 5000),
  },

  rapidapi: {
    key: process.env.RAPIDAPI_KEY || '',
    // Cricket Live Line — ball-by-ball commentary: /match/{id}/commentary
    host: process.env.RAPIDAPI_HOST || 'cricket-live-line1.p.rapidapi.com',
    baseUrl: process.env.RAPIDAPI_BASE_URL
      || `https://${process.env.RAPIDAPI_HOST || 'cricket-live-line1.p.rapidapi.com'}`,
    // Auto-poll is admin-timed (15m/1h/2h sessions). RAPIDAPI_AUTO_POLL is ignored.
    // pollLiveMs / minGapMs are env fallbacks; admin overrides live in app_settings.
    pollLiveMs: num(process.env.RAPIDAPI_POLL_LIVE_MS, 120000),
    minGapMs: num(process.env.RAPIDAPI_MIN_GAP_MS, 2500),
    ep: {
      live: process.env.RAPIDAPI_EP_LIVE || '/liveMatches',
      fixtures: process.env.RAPIDAPI_EP_FIXTURES || '/upcomingMatches',
      scorecard: process.env.RAPIDAPI_EP_SCORECARD || '/match/{id}/scorecard',
      commentary: process.env.RAPIDAPI_EP_COMMENTARY || '/match/{id}/commentary',
    },
  },

  predictions: {
    startingBalance: num(process.env.PREDICTION_STARTING_BALANCE, 1000),
    minStake: num(process.env.PREDICTION_MIN_STAKE, 10),
    maxStake: num(process.env.PREDICTION_MAX_STAKE, 100),
  },

  sportmonks: {
    apiToken: process.env.SPORTMONKS_API_TOKEN || '',
    baseUrl: process.env.SPORTMONKS_BASE_URL || 'https://cricket.sportmonks.com/api/v2.0',
    pollLiveMs: num(process.env.SPORTMONKS_POLL_LIVE_MS, 15000),
    pollBreakMs: num(process.env.SPORTMONKS_POLL_BREAK_MS, 60000),
    syncDays: num(process.env.SPORTMONKS_SYNC_DAYS, 7),
    leagueIds: csv(process.env.SPORTMONKS_LEAGUE_IDS),
  },

  // SportScore free public API (no key). ~1000 req/24h/IP, 60s edge cache,
  // "Powered by SportScore" attribution required on user-facing pages.
  sportscore: {
    baseUrl: process.env.SPORTSCORE_BASE_URL || 'https://sportscore.com',
    // 60s minimum is enforced in the service — upstream caches 60s anyway.
    pollLiveMs: num(process.env.SPORTSCORE_POLL_LIVE_MS, 60000),
    dailyBudget: num(process.env.SPORTSCORE_DAILY_BUDGET, 900),
    userAgent: process.env.SPORTSCORE_UA
      || 'fantasy-poc/1.0 (+https://sportscore.com/developers/)',
  },
};
