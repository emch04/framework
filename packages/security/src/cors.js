const DEFAULT_ALLOWED_HEADERS = 'content-type, authorization, x-csrf-token';
const DEFAULT_ALLOWED_METHODS = 'GET,POST,PATCH,PUT,DELETE,OPTIONS';

const isAllowedDevOrigin = (origin) => {
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const url = new URL(origin);
    return ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
};

/**
 * CORS middleware. Astratra intentionally has no fixed opinion on which
 * origins to allow — that's project-specific — but leaving CORS entirely
 * unaddressed pushed every consumer (including create-astratra-app's own
 * generated template) to hand-roll the same ~15 lines. This promotes that
 * proven logic into a shared, configurable primitive, matching the pattern
 * already used for createWafMiddleware / createCspMiddleware.
 *
 * Passing `options.cors` to createSaasApp mounts this as the FIRST
 * middleware, ahead of everything else — CORS headers, including on the
 * preflight OPTIONS response, must be set before any other handler can
 * short-circuit the request. Omit `options.cors` and nothing changes.
 */
const createCorsMiddleware = (options = {}) => {
  const allowed = new Set(options.allowedOrigins || []);
  const allowDevOrigins = options.allowDevOrigins !== false;
  const allowCredentials = options.credentials !== false;
  const allowedHeaders = options.allowedHeaders || DEFAULT_ALLOWED_HEADERS;
  const allowedMethods = options.allowedMethods || DEFAULT_ALLOWED_METHODS;

  return (req, res, next) => {
    const origin = req.headers && (req.headers.origin || req.headers.Origin);
    if (origin && (allowed.has(origin) || (allowDevOrigins && isAllowedDevOrigin(origin)))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (allowCredentials) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    }
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
    res.setHeader('Access-Control-Allow-Methods', allowedMethods);

    if (String(req.method || 'GET').toUpperCase() === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    return next();
  };
};

module.exports = {
  createCorsMiddleware
};
