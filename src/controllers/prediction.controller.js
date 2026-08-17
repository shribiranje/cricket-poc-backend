const svc = require('../services/prediction.service');
const config = require('../config');
const { ok } = require('../utils/response');

exports.wallet = async (req, res, next) => {
  try {
    const w = await svc.ensureWallet(req.userId);
    ok(res, {
      balance: w.balance,
      limits: { minStake: config.predictions.minStake, maxStake: config.predictions.maxStake },
      multipliers: svc.MULTIPLIERS,
      buyPresets: svc.BUY_PRESETS,
    });
  } catch (e) { next(e); }
};

exports.progress = async (req, res, next) => {
  try { ok(res, await svc.getMatchProgress(Number(req.params.matchId))); }
  catch (e) { next(e); }
};

exports.place = async (req, res, next) => {
  try {
    await svc.placePrediction(req.userId, Number(req.params.matchId), req.body || {});
    const w = await svc.ensureWallet(req.userId);
    ok(res, { placed: true, balance: w.balance }, 201);
  } catch (e) { next(e); }
};

exports.mine = async (req, res, next) => {
  try { ok(res, await svc.myPredictions(req.userId, Number(req.params.matchId))); }
  catch (e) { next(e); }
};

exports.leaderboard = async (req, res, next) => {
  try { ok(res, await svc.leaderboard(Number(req.params.matchId))); }
  catch (e) { next(e); }
};

exports.buyPoints = async (req, res, next) => {
  try { ok(res, await svc.buyPoints(req.userId, req.body?.amount)); }
  catch (e) { next(e); }
};

exports.transactions = async (req, res, next) => {
  try {
    ok(res, await svc.listTransactions(req.userId, {
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) { next(e); }
};

exports.bets = async (req, res, next) => {
  try {
    ok(res, await svc.listAllBets(req.userId, {
      limit: req.query.limit, offset: req.query.offset, status: req.query.status,
    }));
  } catch (e) { next(e); }
};

exports.analytics = async (req, res, next) => {
  try { ok(res, await svc.getUserAnalytics(req.userId)); }
  catch (e) { next(e); }
};
