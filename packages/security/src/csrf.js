const crypto = require('crypto');

const DEFAULT_CSRF_COOKIE_NAME = 'astratra_csrf';
const DEFAULT_CSRF_HEADER_NAME = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const sameSiteValue = (sameSite) => {
  const value = sameSite || 'lax';
  const normalized = String(value).toLowerCase();
  if (normalized === 'strict') return 'Strict';
  if (normalized === 'none') return 'None';
  return 'Lax';
};

const secureValue = (options = {}) => {
  if (options.secure !== undefined) return Boolean(options.secure);
  return process.env.NODE_ENV !== 'development';
};

const appendSetCookie = (res, cookie) => {
  const current = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  if (!current) {
    return res.setHeader('Set-Cookie', cookie);
  }
  if (Array.isArray(current)) {
    return res.setHeader('Set-Cookie', [...current, cookie]);
  }
  return res.setHeader('Set-Cookie', [current, cookie]);
};

const parseCookieHeader = (header) => {
  if (!header) return {};
  return String(header).split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = value;
    return cookies;
  }, {});
};

const cookieValue = (req, name) => {
  if (req.cookies && req.cookies[name]) return req.cookies[name];
  const headers = req.headers || {};
  const parsed = parseCookieHeader(headers.cookie || headers.Cookie);
  return parsed[name];
};

// A Set-Cookie queued earlier in the SAME response (e.g. by
// createCsrfCookiePrimer running ahead of a route's own createCsrfMiddleware)
// never shows up in req.cookies — that only reflects cookies the client sent
// on THIS request. Without this check, two CSRF-aware middlewares on one
// request/response pair would each mint and queue their own token.
const queuedCookieValue = (res, name) => {
  if (typeof res.getHeader !== 'function') return undefined;
  const current = res.getHeader('Set-Cookie');
  if (!current) return undefined;
  const cookies = Array.isArray(current) ? current : [current];
  for (const cookie of cookies) {
    const [pair] = String(cookie).split(';');
    const index = pair.indexOf('=');
    if (index !== -1 && pair.slice(0, index).trim() === name) {
      return pair.slice(index + 1).trim();
    }
  }
  return undefined;
};

const headerValue = (req, name) => {
  if (typeof req.get === 'function') return req.get(name);
  const headers = req.headers || {};
  return headers[name.toLowerCase()] || headers[name];
};

const setCsrfCookie = (res, token, options = {}) => {
  const parts = [
    `${options.name || DEFAULT_CSRF_COOKIE_NAME}=${token}`,
    `Path=${options.path || '/'}`
  ];
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  if (secureValue(options)) {
    parts.push('Secure');
  }
  parts.push(`SameSite=${sameSiteValue(options.sameSite)}`);
  appendSetCookie(res, parts.join('; '));
};

const createCsrfMiddleware = (options = {}) => {
  const cookieName = options.name || DEFAULT_CSRF_COOKIE_NAME;
  const headerName = options.headerName || DEFAULT_CSRF_HEADER_NAME;

  return (req, res, next) => {
    if (options.skip && options.skip(req)) {
      return next();
    }

    let token = cookieValue(req, cookieName) || queuedCookieValue(res, cookieName);
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      setCsrfCookie(res, token, { ...options, name: cookieName });
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) {
      return next();
    }

    if (headerValue(req, headerName) !== token) {
      return res.status(403).json({ success: false, message: 'Invalid CSRF token.' });
    }

    return next();
  };
};

/**
 * Issues the CSRF cookie on any safe request (GET/HEAD/OPTIONS) without
 * ever validating a token. Meant to be mounted once, globally, ahead of
 * all routes — so the double-submit cookie exists by the time a client
 * makes its first mutating request, regardless of which routes happen to
 * mount `createCsrfMiddleware` themselves.
 *
 * Without this, a route that only wires `createCsrfMiddleware` on its
 * mutating handlers (POST/PATCH/DELETE) issues the cookie in the SAME
 * response as the request that needed it validated — the client can never
 * have read it in time, so the very first mutating request always fails
 * with "Invalid CSRF token."
 */
const createCsrfCookiePrimer = (options = {}) => {
  const cookieName = options.name || DEFAULT_CSRF_COOKIE_NAME;

  return (req, res, next) => {
    const method = String(req.method || 'GET').toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      return next();
    }
    if (options.skip && options.skip(req)) {
      return next();
    }
    if (!cookieValue(req, cookieName) && !queuedCookieValue(res, cookieName)) {
      const token = crypto.randomBytes(32).toString('hex');
      setCsrfCookie(res, token, { ...options, name: cookieName });
    }
    return next();
  };
};

module.exports = {
  DEFAULT_CSRF_COOKIE_NAME,
  createCsrfMiddleware,
  createCsrfCookiePrimer
};
