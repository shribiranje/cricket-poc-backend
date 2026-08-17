const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const routes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');
const { fail } = require('./utils/response');

const app = express();

app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
if (config.env !== 'test') app.use(morgan('dev'));

app.use('/api', routes);

app.use((req, res) => fail(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
app.use(errorHandler);

module.exports = app;
