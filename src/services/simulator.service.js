/**
 * Match Event Simulator (interval driver)
 * ---------------------------------------
 * Since the ball-aware engine landed (matchEngine.service.js), this service
 * is a thin timer around it: every SIMULATOR_TICK_MS it plays exactly ONE
 * legal delivery on every LIVE, non-external match — respecting innings,
 * overs, wickets and the target, and auto-completing when innings 2 ends.
 *
 * Contract is unchanged (start / stop / tickOnce), so server.js and the
 * /admin/simulator/tick endpoint keep working as before. All manual and
 * batch play (1 over / 5 overs / innings / end match) goes through
 * matchEngine.playBalls() directly.
 */
const config = require('../config');
const engine = require('./matchEngine.service');

async function tickOnce() {
  await engine.tickAllLiveOneBall();
}

let timer = null;

function start() {
  if (!config.simulator.enabled) {
    console.log('[simulator] disabled by config');
    return;
  }
  if (timer) return;
  console.log(`[simulator] starting, 1 ball every ${config.simulator.tickMs}ms per live match`);
  timer = setInterval(() => {
    tickOnce().catch((e) => console.error('[simulator] tick error', e));
  }, config.simulator.tickMs);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tickOnce };
