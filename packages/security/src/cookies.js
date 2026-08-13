const DEFAULT_SESSION_COOKIE_NAME = 'astratra_session';
const PAST_DATE = 'Thu, 01 Jan 1970 00:00:00 GMT';

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

const serializeCookie = (name, value, options = {}) => {
  const parts = [`${name}=${value}`];
  if (options.maxAgeMs !== undefined) {
    parts.push(`Max-Age=${Math.floor(options.maxAgeMs / 1000)}`);
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires}`);
  }
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (secureValue(options)) {
    parts.push('Secure');
  }
  parts.push(`SameSite=${sameSiteValue(options.sameSite)}`);
  return parts.join('; ');
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

const cookieParserMiddleware = () => (req, res, next) => {
  if (!req.cookies) {
    const headers = req.headers || {};
    req.cookies = parseCookieHeader(headers.cookie || headers.Cookie);
  }
  next();
};

const setSessionCookie = (res, token, options = {}) => appendSetCookie(res, serializeCookie(
  options.name || DEFAULT_SESSION_COOKIE_NAME,
  token,
  {
    ...options,
    httpOnly: true
  }
));

const clearSessionCookie = (res, options = {}) => appendSetCookie(res, serializeCookie(
  options.name || DEFAULT_SESSION_COOKIE_NAME,
  '',
  {
    ...options,
    httpOnly: true,
    maxAgeMs: 0,
    expires: PAST_DATE
  }
));

module.exports = {
  DEFAULT_SESSION_COOKIE_NAME,
  parseCookieHeader,
  cookieParserMiddleware,
  setSessionCookie,
  clearSessionCookie
};
