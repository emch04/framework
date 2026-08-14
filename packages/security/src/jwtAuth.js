const jwt = require('jsonwebtoken');
const { DEFAULT_SESSION_COOKIE_NAME } = require('./cookies');

const DEFAULT_UNAUTHORIZED = {
  success: false,
  message: 'Unauthorized.'
};

const DEFAULT_FORBIDDEN = {
  success: false,
  message: 'Forbidden.'
};

const DEFAULT_ALGORITHMS = ['HS256'];

/**
 * Thrown by the default token extractor when `req.cookies` is `undefined` —
 * meaning `cookieParserMiddleware()` was never mounted ahead of this
 * middleware. That misconfiguration must never be swallowed into a plain
 * 401 (indistinguishable from "no valid session"): it is a wiring bug, not
 * an authentication failure, and otherwise stays silent until someone
 * traces a session that never sticks. See docs/guides/custom-routes-wiring.md.
 */
class AuthConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

const defaultExtractToken = (req) => {
  const cookies = req.cookies;
  if (cookies !== undefined) {
    const cookieToken = cookies[DEFAULT_SESSION_COOKIE_NAME] || cookies.token;
    if (cookieToken) return cookieToken;
  }

  const authorization = req.headers && req.headers.authorization;
  if (authorization && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }

  // Only now, having found no token by any means, does an unparsed
  // req.cookies become suspicious rather than merely "no cookie sent" —
  // a mounted parser always leaves at least `{}` behind (see cookies.js),
  // so `undefined` here can only mean the middleware never ran.
  if (cookies === undefined) {
    throw new AuthConfigurationError(
      'createAuthMiddleware: req.cookies is undefined. Mount cookieParserMiddleware() ' +
      '(from @astratra/security) before this middleware so cookie-based sessions can be read — ' +
      'see the "Cookies" section of the @astratra/security README, or pass a custom ' +
      'options.extractToken if this app never authenticates via cookie.'
    );
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
  const verifySession = options.verifySession || (options.revocationStore
    ? async (decoded) => {
        const revokedByToken = await options.revocationStore.isRevoked(decoded && decoded.jti);
        if (revokedByToken) return false;

        if (
          decoded &&
          decoded.id !== undefined &&
          decoded.iat !== undefined &&
          typeof options.revocationStore.isRevokedForUser === 'function'
        ) {
          const revokedByUser = await options.revocationStore.isRevokedForUser(decoded.id, decoded.iat);
          if (revokedByUser) return false;
        }

        return true;
      }
    : undefined);

  return async (req, res, next) => {
    try {
      const token = extractToken(req);
      if (!token) {
        return res.status(401).json(unauthorizedMessage);
      }

      const decoded = verifyWithRotation(token, options.secret, options.legacySecret, verificationOptions);

      if (verifySession) {
        const isActive = await verifySession(decoded);
        if (!isActive) {
          return res.status(401).json(unauthorizedMessage);
        }
      }

      req.user = decoded;
      return next();
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        return next(error);
      }
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
  authorizeRoles,
  AuthConfigurationError
};
