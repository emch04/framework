const { createLogger } = require('@astratra/core');

const DEFAULT_STATUS_CODES = [401, 403, 429];

const clientIp = (req) => {
  const forwarded = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.connection && req.connection.remoteAddress) || req.ip || undefined;
};

/**
 * A security event trail — none of the other layers (CSRF rejection, WAF
 * block, rate limit, failed JWT auth) logged anything anywhere by default,
 * so an attack attempt was invisible until it succeeded. This observes the
 * response instead of hooking into each middleware individually: any
 * request that ends in one of statusCodes (401/403/429 by default) gets a
 * structured log line, regardless of which layer produced it.
 *
 * Mount early — as early as possible in the stack, and definitely before
 * any router that mounts on a sub-path (e.g. app.use('/users', ...)).
 * Express strips the mount prefix from req.url while a request is inside
 * such a router and only restores it once that router's handling fully
 * unwinds; a response that ends WITHOUT calling next() (an auth rejection,
 * for instance) can fire 'finish' while still inside that stripped
 * context. Reading req.path/req.originalUrl lazily inside the 'finish'
 * listener would then see the truncated path. Capturing method/path/ip
 * up front, before next(), sidesteps that entirely.
 */
const createSecurityAuditLogger = (options = {}) => {
  const statusCodes = new Set(options.statusCodes || DEFAULT_STATUS_CODES);
  const log = options.log || createLogger('astratra-security-audit').warn;

  return (req, res, next) => {
    const method = req.method;
    const path = req.originalUrl || req.path || req.url;
    const ip = clientIp(req);
    // requestIdMiddleware (@astratra/core) sets req.requestId, not req.id —
    // accept either so this also works standalone, ahead of/without it.
    const requestId = req.requestId || req.id;

    res.on('finish', () => {
      if (!statusCodes.has(res.statusCode)) return;

      log('security_event', {
        status: res.statusCode,
        method,
        path,
        ip,
        requestId,
        timestamp: new Date().toISOString()
      });
    });
    next();
  };
};

module.exports = {
  createSecurityAuditLogger
};
