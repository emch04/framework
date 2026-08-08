const apiResponse = require('./apiResponse');

function notFoundMiddleware(req, res) {
  return apiResponse(res, 404, 'Route not found', { path: req.originalUrl || req.url }, false);
}

module.exports = notFoundMiddleware;
