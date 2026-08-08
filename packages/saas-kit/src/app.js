const express = require('express');
const {
  errorMiddleware,
  notFoundMiddleware,
  requestIdMiddleware
} = require('@astratra/core');
const {
  authorizeRoles,
  createApiLimiter,
  createAuthMiddleware,
  createLoginLimiter,
  createWafMiddleware
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
  const jwtAlgorithms = options.jwtAlgorithms || ['HS256'];
  const usersStore = options.usersStore || createMemoryUsersStore();
  const settingsStore = options.settingsStore || createMemorySettingsStore();
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
  app.use(express.json());
  app.use(createWafMiddleware(normalized.waf));
  app.use(createApiLimiter(normalized.apiRateLimit));

  const authMiddleware = createAuthMiddleware({
    secret: normalized.jwtSecret,
    legacySecret: normalized.legacyJwtSecret,
    algorithms: normalized.jwtAlgorithms,
    issuer: normalized.jwtIssuer,
    audience: normalized.jwtAudience,
    verifySession: normalized.verifySession,
    extractToken: normalized.extractToken
  });
  const authorizeAdmin = authorizeRoles(...normalized.roles.adminRoles);

  app.use('/auth', createLoginLimiter(normalized.loginRateLimit), createAuthRoutes({
    ...normalized,
    authMiddleware
  }));

  app.use('/users', authMiddleware, createUsersRoutes({
    usersStore: normalized.usersStore,
    authorizeAdmin
  }));
  app.use('/settings', authMiddleware, createSettingsRoutes({
    settingsStore: normalized.settingsStore,
    authorizeAdmin
  }));
  app.use('/notifications', authMiddleware, createNotificationsRoutes({
    notify: normalized.notify,
    authorizeAdmin
  }));
  app.use('/dashboard', authMiddleware, createDashboardRoutes({
    usersStore: normalized.usersStore
  }));

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

module.exports = {
  createSaasApp
};
