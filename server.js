const app = require('./src/app');
const config = require('./src/config');

const simulator  = require('./src/services/simulator.service');
const sportmonks = require('./src/services/sportmonks.service');
const rapidapi   = require('./src/services/rapidapi.service');
const sportscore = require('./src/services/sportscore.service');
const scheduler  = require('./src/services/scheduler.service');

function activeDataService() {
  if (config.dataSource === 'SPORTMONKS') return sportmonks;
  if (config.dataSource === 'RAPIDAPI') return rapidapi;
  if (config.dataSource === 'SPORTSCORE') return sportscore;
  return simulator;
}

const server = app.listen(config.port, () => {
  console.log(`✓ Fantasy POC API on http://localhost:${config.port}`);
  console.log(`  Data source: ${config.dataSource}`);
  activeDataService().start();
  scheduler.start();
});

const shutdown = (sig) => {
  console.log(`\n${sig} received, shutting down`);
  activeDataService().stop();
  scheduler.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
