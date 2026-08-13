const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { body } = require('express-validator');
const { apiResponse, AppError, asyncHandler, validateMiddleware } = require('@astratra/core');
const { clearSessionCookie, createWebauthnService, setSessionCookie } = require('@astratra/security');
const { pickPublicUser } = require('../utils');

const loginValidation = [
  body('email').isEmail().withMessage('email must be a valid email address'),
  body('password').notEmpty().withMessage('password is required')
];

const JWT_EXPIRY_UNITS_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000
};

const maxAgeMsFromJwtExpiresIn = (jwtExpiresIn) => {
  if (jwtExpiresIn === undefined || jwtExpiresIn === null) return undefined;
  if (typeof jwtExpiresIn === 'number') return jwtExpiresIn * 1000;

  const match = String(jwtExpiresIn).trim().match(/^(\d+)([smhd])$/);
  if (!match) return undefined;
  return Number(match[1]) * JWT_EXPIRY_UNITS_MS[match[2]];
};

const cookieOptionsFrom = (options) => {
  const cookieOptions = { ...(options.cookie || {}) };
  if (cookieOptions.maxAgeMs === undefined) {
    const maxAgeMs = maxAgeMsFromJwtExpiresIn(options.jwtExpiresIn || '1h');
    if (maxAgeMs !== undefined) {
      cookieOptions.maxAgeMs = maxAgeMs;
    }
  }
  return cookieOptions;
};

function createAuthRoutes(options) {
  const router = express.Router();
  const {
    jwtSecret,
    usersStore,
    verifyPassword,
    publicUserFields,
    webauthnStore,
    webauthn
  } = options;
  const cookieOptions = cookieOptionsFrom(options);
  const csrfMiddleware = options.csrfMiddleware || ((req, res, next) => next());

  router.post('/login', validateMiddleware(loginValidation), asyncHandler(async (req, res) => {
    const user = await usersStore.findByEmail(req.body.email);
    const valid = user ? await verifyPassword(user, req.body.password) : false;
    if (!user || !valid) {
      throw new AppError('Invalid credentials.', 401);
    }

    const publicUser = pickPublicUser(user, publicUserFields);
    const jti = crypto.randomUUID();
    const token = jwt.sign({ ...publicUser, jti }, jwtSecret, {
      expiresIn: options.jwtExpiresIn || '1h',
      algorithm: options.jwtAlgorithms[0],
      ...(options.jwtIssuer ? { issuer: options.jwtIssuer } : {}),
      ...(options.jwtAudience ? { audience: options.jwtAudience } : {})
    });
    setSessionCookie(res, token, cookieOptions);
    return apiResponse(res, 200, 'Login successful', { token, user: publicUser });
  }));

  router.post('/logout', options.authMiddleware, csrfMiddleware, asyncHandler(async (req, res) => {
    if (options.revocationStore && req.user && req.user.jti) {
      await options.revocationStore.revoke(req.user.jti, req.user.exp * 1000);
    }
    clearSessionCookie(res, cookieOptions);
    return res.status(200).json({ success: true });
  }));

  router.post('/logout-all', options.authMiddleware, csrfMiddleware, asyncHandler(async (req, res) => {
    if (options.revocationStore && req.user && req.user.id && typeof options.revocationStore.revokeAllForUser === 'function') {
      await options.revocationStore.revokeAllForUser(req.user.id, Date.now());
    }
    clearSessionCookie(res, cookieOptions);
    return res.status(200).json({ success: true });
  }));

  router.get('/me', options.authMiddleware, (req, res) => (
    apiResponse(res, 200, 'Current user', pickPublicUser(req.user, publicUserFields))
  ));

  if (webauthnStore) {
    router.post('/webauthn/register/options', options.authMiddleware, csrfMiddleware, asyncHandler(async (req, res) => {
      const service = createWebauthnService(webauthnStore, webauthn);
      const data = await service.getRegistrationOptions(req, req.user.id, req.user.email || req.user.id);
      return apiResponse(res, 200, 'WebAuthn registration options', data);
    }));

    router.post('/webauthn/register/verify', options.authMiddleware, csrfMiddleware, asyncHandler(async (req, res) => {
      const service = createWebauthnService(webauthnStore, webauthn);
      const data = await service.verifyRegistration(req.user.id, req.body.response, req.body.deviceName);
      return apiResponse(res, 200, 'WebAuthn registration verified', data);
    }));

    router.post('/webauthn/authenticate/options', options.authMiddleware, csrfMiddleware, asyncHandler(async (req, res) => {
      const service = createWebauthnService(webauthnStore, webauthn);
      const data = await service.getAuthenticationOptions(req, req.user.id);
      return apiResponse(res, 200, 'WebAuthn authentication options', data);
    }));

    router.post('/webauthn/authenticate/verify', options.authMiddleware, csrfMiddleware, asyncHandler(async (req, res) => {
      const service = createWebauthnService(webauthnStore, webauthn);
      const verified = await service.verifyAuthentication(req.user.id, req.body.response);
      return apiResponse(res, 200, 'WebAuthn authentication verified', { verified });
    }));
  }

  return router;
}

module.exports = createAuthRoutes;
