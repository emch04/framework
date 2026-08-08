const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const LOCALHOST_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000'
];

const requiredStoreMethods = [
  'getCredentialsForUser',
  'saveCredential',
  'getCredentialById',
  'updateCredentialCounter',
  'saveChallenge',
  'consumeChallenge'
];

const optionalRecoveryStoreMethods = [
  'saveRecoveryCodes',
  'consumeRecoveryCode'
];

const createError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const unique = (items) => [...new Set(items.filter(Boolean))];

const allowedOrigins = (options = {}) => {
  const configured = options.allowedOrigins || process.env.WEBAUTHN_ALLOWED_ORIGINS || '';
  const extra = Array.isArray(configured)
    ? configured
    : configured.split(',').map((origin) => origin.trim());
  const clientUrl = options.clientUrl || process.env.CLIENT_URL;
  return unique([...extra, clientUrl, ...LOCALHOST_ORIGINS]);
};

const rpConfigForRequest = (req, options = {}) => {
  const requestOrigin = req?.headers?.origin;
  const candidates = allowedOrigins(options);
  const origin = requestOrigin && candidates.includes(requestOrigin) ? requestOrigin : candidates[0];

  if (!origin) {
    throw createError('No WebAuthn origin configured.', 500);
  }

  if (requestOrigin && !candidates.includes(requestOrigin)) {
    throw createError(`WebAuthn origin is not allowed: ${requestOrigin}`, 403);
  }

  let rpID;
  try {
    rpID = new URL(origin).hostname;
  } catch (_error) {
    rpID = 'localhost';
  }

  return {
    rpName: options.rpName || process.env.WEBAUTHN_RP_NAME || 'Astratra',
    rpID,
    origin
  };
};

const assertStore = (store) => {
  for (const method of requiredStoreMethods) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`createWebauthnService requires store.${method}.`);
    }
  }
};

const assertRecoveryStore = (store) => {
  for (const method of optionalRecoveryStoreMethods) {
    if (typeof store[method] !== 'function') {
      throw new Error(`Recovery codes require store.${method}.`);
    }
  }
};

const normalizeChallenge = (pending) => {
  if (!pending) return null;
  return {
    challenge: pending.challenge,
    origin: pending.origin || pending.metadata?.origin,
    rpID: pending.rpID || pending.metadata?.rpID,
    expiresAt: pending.expiresAt || pending.metadata?.expiresAt
  };
};

const isExpiredChallenge = (pending) => {
  if (!pending?.expiresAt) return false;
  const expiresAt = new Date(pending.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
};

const publicKeyToBase64Url = (publicKey) => {
  if (Buffer.isBuffer(publicKey)) return publicKey.toString('base64url');
  if (publicKey instanceof Uint8Array) return Buffer.from(publicKey).toString('base64url');
  return String(publicKey);
};

const publicKeyFromBase64Url = (publicKey) => {
  if (Buffer.isBuffer(publicKey)) return publicKey;
  if (publicKey instanceof Uint8Array) return Buffer.from(publicKey);
  return Buffer.from(String(publicKey), 'base64url');
};

const formatRecoveryCode = () => {
  const raw = crypto.randomBytes(4).toString('hex');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
};

const hashRecoveryCode = (code, secret) => {
  if (!secret) {
    throw new Error('Recovery code hashing requires options.recoveryCodeSecret.');
  }

  return crypto.createHash('sha256').update(`${secret}:${String(code).trim().toLowerCase()}`).digest('hex');
};

const createWebauthnService = (store, options = {}) => {
  assertStore(store);

  const challengeTtlMs = options.challengeTtlMs || CHALLENGE_TTL_MS;
  const recoveryCodeCount = options.recoveryCodeCount || RECOVERY_CODE_COUNT;

  const service = {
    async getRegistrationOptions(req, userId, userName) {
      const { rpName, rpID, origin } = rpConfigForRequest(req, options);
      const existing = await store.getCredentialsForUser(userId);

      const registrationOptions = await generateRegistrationOptions({
        rpName,
        rpID,
        userName,
        userID: Buffer.from(String(userId)),
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'required',
          authenticatorAttachment: 'platform'
        },
        excludeCredentials: existing.map((credential) => ({
          id: credential.credentialID || credential.id,
          transports: credential.transports || []
        }))
      });

      await store.saveChallenge(userId, registrationOptions.challenge, 'registration', {
        rpID,
        origin,
        expiresAt: new Date(Date.now() + challengeTtlMs)
      });

      return registrationOptions;
    },

    async verifyRegistration(userId, response, deviceName) {
      const pending = normalizeChallenge(await store.consumeChallenge(userId, 'registration'));
      if (!pending) {
        throw createError('No pending WebAuthn registration challenge.', 400);
      }
      if (isExpiredChallenge(pending)) {
        throw createError('Expired WebAuthn registration challenge.', 400);
      }

      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID
      });

      if (!verification.verified || !verification.registrationInfo) {
        throw createError('WebAuthn registration verification failed.', 400);
      }

      const existing = await store.getCredentialsForUser(userId);
      const isFirstDevice = existing.length === 0;
      const { credential } = verification.registrationInfo;

      await store.saveCredential(userId, {
        credentialID: credential.id,
        publicKey: publicKeyToBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports || [],
        deviceName: deviceName || 'Device'
      });

      const recoveryCodes = isFirstDevice ? await service.generateRecoveryCodes(userId) : null;
      return { verified: true, isFirstDevice, recoveryCodes };
    },

    async getAuthenticationOptions(req, userId) {
      const { rpID, origin } = rpConfigForRequest(req, options);
      const credentials = await store.getCredentialsForUser(userId);
      if (credentials.length === 0) {
        throw createError('No WebAuthn credentials registered.', 400);
      }

      const authenticationOptions = await generateAuthenticationOptions({
        rpID,
        allowCredentials: credentials.map((credential) => ({
          id: credential.credentialID || credential.id,
          transports: credential.transports || []
        })),
        userVerification: 'required'
      });

      await store.saveChallenge(userId, authenticationOptions.challenge, 'authentication', {
        rpID,
        origin,
        expiresAt: new Date(Date.now() + challengeTtlMs)
      });

      return authenticationOptions;
    },

    async verifyAuthentication(userId, response) {
      const pending = normalizeChallenge(await store.consumeChallenge(userId, 'authentication'));
      if (!pending) {
        throw createError('No pending WebAuthn authentication challenge.', 400);
      }
      if (isExpiredChallenge(pending)) {
        throw createError('Expired WebAuthn authentication challenge.', 400);
      }

      const stored = await store.getCredentialById(response.id);
      if (!stored) {
        throw createError('Unknown WebAuthn credential.', 401);
      }
      if (String(stored.userId) !== String(userId)) {
        throw createError('WebAuthn credential does not belong to this user.', 401);
      }

      const credentialID = stored.credentialID || stored.id;
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID,
        credential: {
          id: credentialID,
          publicKey: publicKeyFromBase64Url(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports || []
        }
      });

      if (!verification.verified) {
        throw createError('WebAuthn authentication verification failed.', 401);
      }

      await store.updateCredentialCounter(credentialID, verification.authenticationInfo.newCounter);
      return true;
    },

    async hasCredentials(userId) {
      const credentials = await store.getCredentialsForUser(userId);
      return credentials.length > 0;
    },

    async generateRecoveryCodes(userId) {
      assertRecoveryStore(store);

      const codes = Array.from({ length: recoveryCodeCount }, formatRecoveryCode);
      const hashes = codes.map((code) => hashRecoveryCode(code, options.recoveryCodeSecret));
      await store.saveRecoveryCodes(userId, hashes);
      return codes;
    },

    async verifyRecoveryCode(userId, code) {
      assertRecoveryStore(store);

      const hash = hashRecoveryCode(code, options.recoveryCodeSecret);
      return store.consumeRecoveryCode(userId, hash);
    },

    hashRecoveryCode(code) {
      return hashRecoveryCode(code, options.recoveryCodeSecret);
    },

    rpConfigForRequest(req) {
      return rpConfigForRequest(req, options);
    }
  };

  return service;
};

module.exports = {
  createWebauthnService,
  rpConfigForRequest,
  hashRecoveryCode,
  CHALLENGE_TTL_MS,
  RECOVERY_CODE_COUNT
};
