const express = require('express');
const {
  errorMiddleware,
  notFoundMiddleware,
  requestIdMiddleware
} = require('@astratra/core');
const {
  authorizeRoles,
  cookieParserMiddleware,
  createApiLimiter,
  createAuthMiddleware,
  createCspMiddleware,
  createCsrfMiddleware,
  createLoginLimiter,
  createMemoryRevocationStore,
  createWafMiddleware,
  DEFAULT_SESSION_COOKIE_NAME
} = require('@astratra/security');
const createAuthRoutes = require('./modules/auth');
const createDashboardRoutes = require('./modules/dashboard');
const createNotificationsRoutes = require('./modules/notifications');
const createSettingsRoutes = require('./modules/settings');
const createUsersRoutes = require('./modules/users');
const createMemorySettingsStore = require('./stores/memorySettingsStore');
const createMemoryUsersStore = require('./stores/memoryUsersStore');
const { DEFAULT_PUBLIC_USER_FIELDS, assertAdapter } = require('./utils');

const DEFAULT_JWT_SECRET = 'saas-kit-dev-secret';
const DEFAULT_ROLES = {
  adminRoles: ['owner', 'admin']
};

function normalizeOptions(options = {}) {
  const jwtSecret = options.jwtSecret || process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && jwtSecret === DEFAULT_JWT_SECRET) {
    throw new Error('createSaasApp requires options.jwtSecret or JWT_SECRET in production.');
  }

  const jwtAlgorithms = options.jwtAlgorithms || ['HS256'];
  const usersStore = options.usersStore || createMemoryUsersStore();
  const settingsStore = options.settingsStore || createMemorySettingsStore();
  const revocationStore = options.revocationStore || createMemoryRevocationStore();
  const notify = options.notify;
  const verifyPassword = options.verifyPassword;
  const roles = { ...DEFAULT_ROLES, ...(options.roles || {}) };
  const publicUserFields = options.publicUserFields || DEFAULT_PUBLIC_USER_FIELDS;

  assertAdapter(usersStore, ['findByEmail', 'findById', 'create', 'list', 'update'], 'options.usersStore');
  assertAdapter(settingsStore, ['get', 'set', 'getAll'], 'options.settingsStore');
  if (typeof notify !== 'function') {
    throw new Error('createSaasApp requires options.notify to be a function.');
  }
  if (typeof verifyPassword !== 'function') {
    throw new Error('createSaasApp requires options.verifyPassword to be a function.');
  }

  return {
    ...options,
    jwtSecret,
    jwtAlgorithms,
    jwtIssuer: options.jwtIssuer,
    jwtAudience: options.jwtAudience,
    usersStore,
    settingsStore,
    revocationStore,
    notify,
    verifyPassword,
    roles,
    publicUserFields
  };
}

function createSaasApp(options = {}) {
  const normalized = normalizeOptions(options);
  const app = express();

  app.use(requestIdMiddleware);
  app.use(cookieParserMiddleware());
  app.use(createCspMiddleware(normalized.csp));
  app.use(express.json());
  app.use(createWafMiddleware(normalized.waf));
  app.use(createApiLimiter(normalized.apiRateLimit));

  const sessionCookieName = (normalized.cookie && normalized.cookie.name) || DEFAULT_SESSION_COOKIE_NAME;
  const extractToken = normalized.extractToken || ((req) => {
    const cookieToken = req.cookies && req.cookies[sessionCookieName];
    if (cookieToken) return cookieToken;
    const authorization = req.headers && req.headers.authorization;
    if (authorization && authorization.startsWith('Bearer ')) {
      return authorization.slice('Bearer '.length);
    }
    return null;
  });

  const authMiddleware = createAuthMiddleware({
    secret: normalized.jwtSecret,
    legacySecret: normalized.legacyJwtSecret,
    algorithms: normalized.jwtAlgorithms,
    issuer: normalized.jwtIssuer,
    audience: normalized.jwtAudience,
    verifySession: normalized.verifySession,
    revocationStore: normalized.revocationStore,
    extractToken
  });
  const authorizeAdmin = authorizeRoles(...normalized.roles.adminRoles);

  // Bearer-authenticated clients (mobile/API) aren't vulnerable to CSRF: a browser
  // never auto-attaches an Authorization header cross-site the way it does a cookie.
  const isBearerAuthenticated = (req) => {
    const authorization = req.headers && req.headers.authorization;
    return Boolean(authorization && authorization.startsWith('Bearer '));
  };
  const csrfMiddleware = createCsrfMiddleware({
    ...normalized.csrf,
    skip: (req) => isBearerAuthenticated(req) || (normalized.csrf && normalized.csrf.skip && normalized.csrf.skip(req))
  });

  app.use('/auth', createLoginLimiter(normalized.loginRateLimit), createAuthRoutes({
    ...normalized,
    authMiddleware,
    csrfMiddleware
  }));

  app.use('/users', authMiddleware, csrfMiddleware, createUsersRoutes({
    usersStore: normalized.usersStore,
    authorizeAdmin,
    publicUserFields: normalized.publicUserFields
  }));
  app.use('/settings', authMiddleware, csrfMiddleware, createSettingsRoutes({
    settingsStore: normalized.settingsStore,
    authorizeAdmin
  }));
  app.use('/notifications', authMiddleware, csrfMiddleware, createNotificationsRoutes({
    notify: normalized.notify,
    authorizeAdmin
  }));
  app.use('/dashboard', authMiddleware, csrfMiddleware, createDashboardRoutes({
    usersStore: normalized.usersStore
  }));

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

module.exports = {
  createSaasApp
};
