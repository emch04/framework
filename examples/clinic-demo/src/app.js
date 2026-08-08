const express = require('express');
const {
  errorMiddleware,
  notFoundMiddleware,
  requestIdMiddleware
} = require('@astratra/core');
const {
  createApiLimiter,
  createAuthMiddleware,
  createLoginLimiter,
  createWafMiddleware
} = require('@astratra/security');
const buildAuthRoutes = require('./routes/auth.routes');
const createClinicRoutes = require('./routes/clinic.routes');

const DEFAULT_JWT_SECRET = 'clinic-demo-secret';

function createApp(options = {}) {
  const app = express();
  const jwtSecret = options.jwtSecret || process.env.JWT_SECRET || DEFAULT_JWT_SECRET;

  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(createWafMiddleware(options.waf));
  app.use(createApiLimiter(options.apiRateLimit));
  app.use('/auth', createLoginLimiter(options.loginRateLimit), buildAuthRoutes({ jwtSecret }));

  const authMiddleware = createAuthMiddleware({ secret: jwtSecret });
  app.use(createClinicRoutes(authMiddleware));

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

module.exports = {
  createApp
};
