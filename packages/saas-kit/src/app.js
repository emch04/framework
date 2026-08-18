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
  createCorsMiddleware,
  createCspMiddleware,
  createCsrfCookiePrimer,
  createCsrfMiddleware,
  createLoginLimiter,
  createMemoryRevocationStore,
  createMongoSanitizeMiddleware,
  createSecurityAuditLogger,
  createSecurityHeadersMiddleware,
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

  // Off by default — whether an app sits behind a reverse proxy (nginx,
  // an ALB...) is a deployment detail Astratra can't guess, and trusting
  // X-Forwarded-For blindly when there's no proxy in front lets a client
  // spoof its own IP straight past the rate limiters below. Found on a real
  // consumer app deployed behind nginx: without this, every visitor shared
  // the same rate-limit bucket (nginx's own loopback IP), because Express
  // never trusted the header carrying the real client IP.
  // `1` = trust exactly one hop (nginx as the sole proxy); see Express's
  // `trust proxy` docs for other topologies (multiple proxies, IP ranges).
  if (normalized.trustProxy !== undefined) {
    app.set('trust proxy', normalized.trustProxy);
  }

  // Astratra imposes no fixed CORS policy — which origins to allow is
  // project-specific — but leaves the primitive available so consumers
  // don't reinvent it. Mounted FIRST, ahead of everything else: CORS
  // headers (including on the OPTIONS preflight response) must be set
  // before any other middleware can short-circuit the request. Omit
  // options.cors and this is a no-op, unchanged from before.
  if (normalized.cors) {
    app.use(createCorsMiddleware(normalized.cors === true ? {} : normalized.cors));
  }

  app.use(requestIdMiddleware);
  // Every request that ends in 401/403/429 (failed auth, CSRF/WAF block,
  // rate limit) gets a structured log line — none of those layers logged
  // anything anywhere before this, so an attack attempt was invisible
  // until it succeeded. Mounted early so req.id is already set; observes
  // the response rather than hooking each layer individually, so where
  // exactly it sits in the stack otherwise doesn't matter. Pass
  // options.securityAudit: false to disable.
  if (normalized.securityAudit !== false) {
    app.use(createSecurityAuditLogger(normalized.securityAudit === true ? {} : normalized.securityAudit));
  }
  app.use(cookieParserMiddleware());
  // Seeds the CSRF cookie on every safe request (GET/HEAD/OPTIONS), globally,
  // before any route — including custom routes mounted via extendRoutes.
  // Without this, a route wiring createCsrfMiddleware only on its mutating
  // handlers issues the cookie in the SAME response that needed it
  // validated, so the client's first mutating request always fails.
  app.use(createCsrfCookiePrimer(normalized.csrf));
  app.use(createCspMiddleware(normalized.csp));
  // Every option here has a safe universal default (unlike CORS, nothing
  // needs a project-specific decision), so this is unconditional like CSP.
  app.use(createSecurityHeadersMiddleware(normalized.securityHeaders));
  app.use(express.json());
  // Every option here has a safe universal default (no legitimate client
  // ever sends a `$`-prefixed or dotted JSON key), so unconditional like
  // CSP/securityHeaders — pass `mongoSanitize: false` to disable.
  if (normalized.mongoSanitize !== false) {
    app.use(createMongoSanitizeMiddleware(normalized.mongoSanitize === true ? {} : normalized.mongoSanitize));
  }
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

  // Exposed so a consumer can reuse the exact same auth/CSRF instances
  // instead of rebuilding duplicates with (easy to get out of sync)
  // options — e.g. `app.use('/api', app.authMiddleware, app.csrfMiddleware)`.
  app.authMiddleware = authMiddleware;
  app.csrfMiddleware = csrfMiddleware;
  app.authorizeAdmin = authorizeAdmin;

  // createSaasApp() already terminates its own middleware stack with a
  // catch-all 404 + error handler below. Any route registered on `app`
  // AFTER createSaasApp() returns is therefore unreachable — Express
  // evaluates middleware in registration order, and notFoundMiddleware
  // matches every path unconditionally. `extendRoutes` is the supported
  // way to add your own routes: it runs here, before that catch-all.
  //
  //   createSaasApp({
  //     ...,
  //     extendRoutes: (app, { authMiddleware, csrfMiddleware }) => {
  //       app.get('/api/products', authMiddleware, asyncHandler(...));
  //       app.post('/api/products', authMiddleware, csrfMiddleware, asyncHandler(...));
  //     }
  //   });
  if (typeof normalized.extendRoutes === 'function') {
    normalized.extendRoutes(app, { authMiddleware, csrfMiddleware, authorizeAdmin, authorizeRoles });
  }

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

module.exports = {
  createSaasApp
};
