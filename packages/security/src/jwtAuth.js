const jwt = require('jsonwebtoken');

const DEFAULT_UNAUTHORIZED = {
  success: false,
  message: 'Unauthorized.'
};

const DEFAULT_FORBIDDEN = {
  success: false,
  message: 'Forbidden.'
};

const DEFAULT_ALGORITHMS = ['HS256'];

const defaultExtractToken = (req) => {
  const cookieToken = req.cookies && req.cookies.token;
  if (cookieToken) return cookieToken;

  const authorization = req.headers && req.headers.authorization;
  if (authorization && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }

  return null;
};

const verificationOptionsFrom = (options = {}) => ({
  algorithms: options.algorithms || DEFAULT_ALGORITHMS,
  ...(options.issuer ? { issuer: options.issuer } : {}),
  ...(options.audience ? { audience: options.audience } : {}),
  ...(options.clockTolerance !== undefined ? { clockTolerance: options.clockTolerance } : {}),
  ...(options.maxAge ? { maxAge: options.maxAge } : {})
});

const verifyWithRotation = (token, secret, legacySecret, verificationOptions) => {
  try {
    return jwt.verify(token, secret, verificationOptions);
  } catch (error) {
    if (legacySecret && error.name === 'JsonWebTokenError') {
      return jwt.verify(token, legacySecret, verificationOptions);
    }
    throw error;
  }
};

const createAuthMiddleware = (options = {}) => {
  if (!options.secret) {
    throw new Error('createAuthMiddleware requires options.secret.');
  }

  const extractToken = options.extractToken || defaultExtractToken;
  const unauthorizedMessage = options.message || DEFAULT_UNAUTHORIZED;
  const verificationOptions = verificationOptionsFrom(options);

  return async (req, res, next) => {
    try {
      const token = extractToken(req);
      if (!token) {
        return res.status(401).json(unauthorizedMessage);
      }

      const decoded = verifyWithRotation(token, options.secret, options.legacySecret, verificationOptions);

      if (options.verifySession) {
        const isActive = await options.verifySession(decoded);
        if (!isActive) {
          return res.status(401).json(unauthorizedMessage);
        }
      }

      req.user = decoded;
      return next();
    } catch (_error) {
      return res.status(401).json(unauthorizedMessage);
    }
  };
};

const authorizeRoles = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json(DEFAULT_FORBIDDEN);
  }

  return next();
};

module.exports = {
  createAuthMiddleware,
  authorizeRoles
};
