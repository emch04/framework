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

    let token = cookieValue(req, cookieName);
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

module.exports = {
  DEFAULT_CSRF_COOKIE_NAME,
  createCsrfMiddleware
};
