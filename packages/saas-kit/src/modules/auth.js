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
    webauthn,
    refreshTokenService,
    passwordResetStore,
    passwordReset,
    hashPassword
  } = options;
  const cookieOptions = cookieOptionsFrom(options);
  const csrfMiddleware = options.csrfMiddleware || ((req, res, next) => next());

  /**
   * One place that mints an access token, because two would drift: the refresh
   * route must produce a token indistinguishable from the login one.
   */
  const signAccessToken = (publicUser, claims = {}) => jwt.sign(
    { ...publicUser, jti: crypto.randomUUID(), ...claims },
    jwtSecret,
    {
      expiresIn: options.jwtExpiresIn || '1h',
      algorithm: options.jwtAlgorithms[0],
      ...(options.jwtIssuer ? { issuer: options.jwtIssuer } : {}),
      ...(options.jwtAudience ? { audience: options.jwtAudience } : {})
    }
  );

  router.post('/login', validateMiddleware(loginValidation), asyncHandler(async (req, res) => {
    const user = await usersStore.findByEmail(req.body.email);
    const valid = user ? await verifyPassword(user, req.body.password) : false;
    if (!user || !valid) {
      throw new AppError('Invalid credentials.', 401);
    }

    const publicUser = pickPublicUser(user, publicUserFields);

    /* A refresh token is issued only when the product asked for one. The web
       client rides on an HttpOnly cookie and needs none; handing it a
       long-lived credential it never uses only widens the target. */
    let refresh = null;
    if (refreshTokenService) {
      refresh = await refreshTokenService.issue({ userId: String(user.id) });
    }

    /* The family id travels in the access token so that signing out can revoke
       the refresh chain without the client having to hand it back. */
    const token = signAccessToken(publicUser, refresh ? { rfid: refresh.familyId } : {});
    setSessionCookie(res, token, cookieOptions);

    return apiResponse(res, 200, 'Login successful', {
      token,
      user: publicUser,
      ...(refresh ? { refreshToken: refresh.token } : {})
    });
  }));

  if (refreshTokenService) {
    /* No auth middleware here, deliberately: the access token is expected to
       be DEAD by the time this is called. The refresh token is the credential.
       No CSRF either — this route is for Bearer clients, which cookies-based
       CSRF does not apply to, and a cookie client never needs it. */
    router.post('/refresh', asyncHandler(async (req, res) => {
      let rotated;
      try {
        rotated = await refreshTokenService.rotate(req.body && req.body.refreshToken);
      } catch (_error) {
        /* Invalid, expired, replayed: the client is told the same thing in all
           three cases. Which one it was is our business, not an attacker's. */
        throw new AppError('Session expired. Please sign in again.', 401);
      }

      const user = await usersStore.findById(rotated.userId);
      if (!user) throw new AppError('Session expired. Please sign in again.', 401);

      const publicUser = pickPublicUser(user, publicUserFields);
      const token = signAccessToken(publicUser, { rfid: rotated.familyId });
      setSessionCookie(res, token, cookieOptions);

      return apiResponse(res, 200, 'Session refreshed', {
        token,
        user: publicUser,
        refreshToken: rotated.token
      });
    }));
  }

  router.post('/logout', options.authMiddleware, csrfMiddleware, asyncHandler(async (req, res) => {
    if (options.revocationStore && req.user && req.user.jti) {
      await options.revocationStore.revoke(req.user.jti, req.user.exp * 1000);
    }
    /* Revoking the access token alone would leave the refresh token alive —
       the session would come back on the next renewal. */
    if (refreshTokenService && req.user && req.user.rfid) {
      await refreshTokenService.revokeFamily(req.user.rfid);
    }
    clearSessionCookie(res, cookieOptions);
    return res.status(200).json({ success: true });
  }));

  router.post('/logout-all', options.authMiddleware, csrfMiddleware, asyncHandler(async (req, res) => {
    if (options.revocationStore && req.user && req.user.id && typeof options.revocationStore.revokeAllForUser === 'function') {
      await options.revocationStore.revokeAllForUser(req.user.id, Date.now());
    }
    if (refreshTokenService && req.user && req.user.id) {
      await refreshTokenService.revokeAllForUser(String(req.user.id));
    }
    clearSessionCookie(res, cookieOptions);
    return res.status(200).json({ success: true });
  }));

  if (passwordReset && typeof passwordReset.send === 'function') {
    const resetTtlMs = passwordReset.ttlMs || 60 * 60 * 1000;
    const fingerprint = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

    /**
     * THE ANSWER NEVER DEPENDS ON WHETHER THE ADDRESS EXISTS.
     *
     * "No account with that email" turns this screen into a directory: feed it
     * a list and it tells you, for free, which addresses have accounts here.
     * So the reply, the status and the timing-free path are identical either
     * way; only the sending differs, and that is invisible from outside.
     */
    router.post('/forgot-password', validateMiddleware([
      body('email').isEmail().withMessage('email must be a valid email address')
    ]), asyncHandler(async (req, res) => {
      const user = await usersStore.findByEmail(req.body.email);

      if (user) {
        /* Hex, not base64url: a '--' in the token would be read as an SQL
           comment by the WAF and blocked, making that reset link permanently
           unusable. See @astratra/security's refresh tokens for the full
           story. */
        const token = crypto.randomBytes(32).toString('hex');
        await passwordResetStore.save({
          hash: fingerprint(token),
          userId: String(user.id),
          expiresAt: Date.now() + resetTtlMs
        });
        try {
          await passwordReset.send({ user: pickPublicUser(user, publicUserFields), token });
        } catch (_error) {
          /* A mail transport that is down must not become an oracle either:
             the caller is told the same thing as always. */
        }
      }

      return apiResponse(res, 200, 'If that address has an account, a reset link is on its way.', null);
    }));

    router.post('/reset-password', validateMiddleware([
      body('token').notEmpty().withMessage('token is required'),
      body('password').notEmpty().withMessage('password is required')
    ]), asyncHandler(async (req, res) => {
      /* Consuming DELETES the record, so a second attempt with the same link
         finds nothing — the single-use rule needs no extra flag. */
      const record = await passwordResetStore.consume(fingerprint(req.body.token));
      if (!record || record.expiresAt <= Date.now()) {
        throw new AppError('This reset link is no longer valid.', 400);
      }

      const user = await usersStore.findById(record.userId);
      if (!user) throw new AppError('This reset link is no longer valid.', 400);

      await usersStore.update(record.userId, { password: await hashPassword(req.body.password) });

      /* The step everyone forgets. Someone resetting a password may be
         recovering a stolen account: leaving the thief's sessions alive makes
         the whole exercise pointless. */
      if (options.revocationStore && typeof options.revocationStore.revokeAllForUser === 'function') {
        await options.revocationStore.revokeAllForUser(record.userId, Date.now());
      }
      if (refreshTokenService) {
        await refreshTokenService.revokeAllForUser(record.userId);
      }
      await passwordResetStore.deleteForUser(record.userId);

      return apiResponse(res, 200, 'Password updated. Please sign in again.', null);
    }));
  }

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
