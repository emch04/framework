const apiResponse = require('./apiResponse');

function logError(err, req) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  const logger = (req && req.log) || console;
  const log = typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
  log(`[requestId=${(req && req.requestId) || 'n/a'}]`, err);
}

// Express only recognizes an error handler by arity (4 params) — `_next` must
// stay even though it's unused.
function errorMiddleware(err, req, res, _next) {
  const statusCode = err.statusCode || err.status || 500;
  const isServerError = statusCode >= 500;
  const isProduction = process.env.NODE_ENV === 'production';
  const message = isProduction && isServerError ? 'Internal server error' : err.message || 'Error';
  const data = !isProduction && err.stack ? { stack: err.stack } : null;

  if (isServerError) {
    logError(err, req);
  }

  return apiResponse(res, statusCode, message, data, false);
}

module.exports = errorMiddleware;
