const express = require('express');
const jwt = require('jsonwebtoken');
const { body } = require('express-validator');
const { apiResponse, AppError, asyncHandler, validateMiddleware } = require('@astratra/core');
const { createWebauthnService } = require('@astratra/security');
const { pickPublicUser } = require('../utils');

const loginValidation = [
  body('email').isEmail().withMessage('email must be a valid email address'),
  body('password').notEmpty().withMessage('password is required')
];

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

  router.post('/login', validateMiddleware(loginValidation), asyncHandler(async (req, res) => {
    const user = await usersStore.findByEmail(req.body.email);
    const valid = user ? await verifyPassword(user, req.body.password) : false;
    if (!user || !valid) {
      throw new AppError('Invalid credentials.', 401);
    }

    const publicUser = pickPublicUser(user, publicUserFields);
    const token = jwt.sign(publicUser, jwtSecret, {
      expiresIn: options.jwtExpiresIn || '1h',
      algorithm: options.jwtAlgorithms[0],
      ...(options.jwtIssuer ? { issuer: options.jwtIssuer } : {}),
      ...(options.jwtAudience ? { audience: options.jwtAudience } : {})
    });
    return apiResponse(res, 200, 'Login successful', { token, user: publicUser });
  }));

  router.get('/me', options.authMiddleware, (req, res) => (
    apiResponse(res, 200, 'Current user', pickPublicUser(req.user, publicUserFields))
  ));

  if (webauthnStore) {
    router.post('/webauthn/register/options', options.authMiddleware, asyncHandler(async (req, res) => {
      const service = createWebauthnService(webauthnStore, webauthn);
      const data = await service.getRegistrationOptions(req, req.user.id, req.user.email || req.user.id);
      return apiResponse(res, 200, 'WebAuthn registration options', data);
    }));

    router.post('/webauthn/register/verify', options.authMiddleware, asyncHandler(async (req, res) => {
      const service = createWebauthnService(webauthnStore, webauthn);
      const data = await service.verifyRegistration(req.user.id, req.body.response, req.body.deviceName);
      return apiResponse(res, 200, 'WebAuthn registration verified', data);
    }));

    router.post('/webauthn/authenticate/options', options.authMiddleware, asyncHandler(async (req, res) => {
      const service = createWebauthnService(webauthnStore, webauthn);
      const data = await service.getAuthenticationOptions(req, req.user.id);
      return apiResponse(res, 200, 'WebAuthn authentication options', data);
    }));

    router.post('/webauthn/authenticate/verify', options.authMiddleware, asyncHandler(async (req, res) => {
      const service = createWebauthnService(webauthnStore, webauthn);
      const verified = await service.verifyAuthentication(req.user.id, req.body.response);
      return apiResponse(res, 200, 'WebAuthn authentication verified', { verified });
    }));
  }

  return router;
}

module.exports = createAuthRoutes;
