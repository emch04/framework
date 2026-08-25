/**
 * The service-keys screen, server side.
 *
 * These keys commit the whole platform's payments and mail, not one tenant's.
 * Which accounts may reach them is your decision, so `authorize` is required —
 * there is no sensible default for "who owns the money".
 *
 * One rule holds the whole file: a secret value goes in and never comes back
 * out. Every response describes a key; none carries one.
 */
const express = require('express');
const { body, param } = require('express-validator');
const { apiResponse, asyncHandler, validateMiddleware } = require('@astratra/core');

const NOOP_LOGGER = { info() {} };

const setValidation = [
  param('key').trim().notEmpty().isLength({ max: 200 }).withMessage('key must be between 1 and 200 characters'),
  body('value').isString().trim().notEmpty().withMessage('value is required')
];

const unlockValidation = [
  body('code').isString().trim().notEmpty().withMessage('code is required')
];

/**
 * @param {object} options
 * @param {object} options.vault      from createCredentialVault().
 * @param {Function} options.authorize express middleware guarding every route.
 * @param {object} [options.challenge] from createUnlockChallenge(). Without it,
 *   no second factor stands between an admin session and a payment key.
 * @param {Function} [options.subjectOf] (req) => id. Defaults to req.user.id.
 * @param {object} [options.logger]   { info } — records who changed what, never the value.
 */
function createCredentialsRoutes(options = {}) {
  const vault = options.vault;
  if (!vault || typeof vault.status !== 'function') {
    throw new Error('createCredentialsRoutes requires options.vault from createCredentialVault().');
  }

  const authorize = options.authorize;
  if (typeof authorize !== 'function') {
    throw new Error('createCredentialsRoutes requires options.authorize.');
  }

  const challenge = options.challenge || null;
  const subjectOf = options.subjectOf || ((req) => req.user && req.user.id);
  const logger = options.logger || NOOP_LOGGER;

  const requireUnlocked = async (req) => {
    if (challenge) await challenge.assertUnlocked(subjectOf(req));
  };

  const router = express.Router();
  router.use(authorize);

  /** The state of every managed key. */
  router.get('/', asyncHandler(async (req, res) => {
    const state = await vault.status();
    /* The screen needs to know whether the window is open: otherwise it offers
       "Edit" only to hit a refusal once the key has been typed. */
    const unlockedUntil = challenge ? await challenge.unlockedUntil(subjectOf(req)) : null;
    return apiResponse(res, 200, 'Credential status', { ...state, unlockedUntil });
  }));

  /** Send the change code to the address already on the account. */
  router.post('/challenge', asyncHandler(async (req, res) => {
    if (!challenge) return apiResponse(res, 404, 'No unlock challenge is configured.');
    const result = await challenge.requestCode(subjectOf(req));
    return apiResponse(res, 200, 'A code has been sent.', result);
  }));

  /** Check the code and open the editing window. */
  router.post('/unlock', validateMiddleware(unlockValidation), asyncHandler(async (req, res) => {
    if (!challenge) return apiResponse(res, 404, 'No unlock challenge is configured.');
    const result = await challenge.verifyCode(subjectOf(req), req.body.code);
    return apiResponse(res, 200, 'Keys can be changed for the next few minutes.', result);
  }));

  /** Store a key. */
  router.put('/:key', validateMiddleware(setValidation), asyncHandler(async (req, res) => {
    /* Knowing the account password is not enough: replacing a payment key with
       your own breaks nothing visible, the money simply goes elsewhere. */
    await requireUnlocked(req);
    await vault.set(req.params.key, req.body.value, { updatedBy: subjectOf(req) });
    logger.info(`[credentials] ${req.params.key} stored by ${subjectOf(req)}`);
    return apiResponse(res, 200, 'Key stored.', { key: req.params.key });
  }));

  /** Unplug a key — the environment does not take over. */
  router.delete('/:key', asyncHandler(async (req, res) => {
    /* Unplugging a service is as consequential as plugging one in. */
    await requireUnlocked(req);
    await vault.disconnect(req.params.key, { updatedBy: subjectOf(req) });
    logger.info(`[credentials] ${req.params.key} disconnected by ${subjectOf(req)}`);
    return apiResponse(res, 200, 'Key disconnected.', { key: req.params.key });
  }));

  return router;
}

module.exports = { createCredentialsRoutes };
