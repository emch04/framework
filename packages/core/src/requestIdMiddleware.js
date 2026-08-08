const { randomUUID } = require('crypto');

function getIncomingRequestId(req) {
  if (!req || !req.headers) {
    return null;
  }

  return req.headers['x-request-id'] || req.headers['X-Request-Id'] || null;
}

function requestIdMiddleware(req, res, next) {
  const requestId = getIncomingRequestId(req) || randomUUID();
  req.requestId = requestId;

  if (typeof res.setHeader === 'function') {
    res.setHeader('X-Request-Id', requestId);
  } else if (typeof res.set === 'function') {
    res.set('X-Request-Id', requestId);
  }

  return next();
}

module.exports = requestIdMiddleware;
