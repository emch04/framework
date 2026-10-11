/**
 * Vérifier un jeton d'identité OpenID Connect (Google, Apple, tout fournisseur
 * qui publie ses clés en JWKS) sans dépendance JOSE : Node transforme chaque
 * JWK en KeyObject, jsonwebtoken vérifie la signature, l'émetteur, l'audience
 * et l'expiration.
 *
 * Ce que le module garantit, chaque point testé :
 *
 *   RS256 SEULEMENT. Un jeton qui annonce « none » ou HS256 est refusé avant
 *   toute lecture de ses champs : la clé publique ne devient jamais un secret
 *   HMAC.
 *
 *   ROTATION BORNÉE. Un `kid` inconnu déclenche UN rechargement des clés
 *   (les fournisseurs les font tourner), jamais plus d'une fois par
 *   `minRefreshMs` : un flot de jetons forgés ne transforme pas le serveur en
 *   relais qui martèle le fournisseur. Deux vérifications simultanées
 *   partagent le même rechargement.
 *
 *   NONCE. Quand l'appelant donne le nonce attendu, le jeton doit porter
 *   exactement celui-là : un jeton capturé ailleurs ne se rejoue pas.
 *
 *   L'ADRESSE N'EST PAS UNE PREUVE. `emailVerified` n'est vrai que si le
 *   fournisseur l'affirme ; l'adresse relais d'Apple (« Masquer mon
 *   adresse ») est signalée par `relayEmail`. Le lien durable entre un compte
 *   et le fournisseur est `subject` (le `sub`), jamais l'adresse.
 *
 * Toute erreur est une IdTokenError avec un code stable ; son message ne
 * contient jamais le jeton.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const DEFAULT_CACHE_MS = 60 * 60 * 1000;
const DEFAULT_MIN_REFRESH_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_KEYS = 50;
const MAX_TOKEN_LENGTH = 16 * 1024;

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUERS = ['https://appleid.apple.com'];

const ID_TOKEN_ERROR_CODES = ['malformed', 'unknown_key', 'keys_unavailable', 'expired', 'invalid', 'nonce_mismatch'];

class IdTokenError extends Error {
  constructor(code, message) {
    super(message || `ID token rejected (${code}).`);
    this.name = 'IdTokenError';
    this.code = code;
    this.statusCode = code === 'keys_unavailable' ? 503 : 401;
  }
}

const truthy = (value) => value === true || value === 'true';

/** L'empreinte d'un nonce telle qu'Apple la place dans le jeton : SHA-256 en hexadécimal. */
function hashNonce(rawNonce) {
  return crypto.createHash('sha256').update(String(rawNonce)).digest('hex');
}

/**
 * @param {object} options
 * @param {string} options.jwksUrl
 * @param {string[]} options.issuers
 * @param {string[]} options.audiences  identifiants de client acceptés (jamais vide).
 * @param {Function} [options.fetch]
 * @param {Function} [options.now]  millisecondes (sert aussi à juger l'expiration).
 * @param {number} [options.cacheMs]
 * @param {number} [options.minRefreshMs]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.clockToleranceSec]
 */
function createIdTokenVerifier(options = {}) {
  const {
    jwksUrl,
    issuers,
    audiences,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    cacheMs = DEFAULT_CACHE_MS,
    minRefreshMs = DEFAULT_MIN_REFRESH_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    clockToleranceSec = 0
  } = options;

  if (typeof jwksUrl !== 'string' || !jwksUrl || !Array.isArray(issuers) || issuers.length === 0
    || !Array.isArray(audiences) || audiences.filter((a) => typeof a === 'string' && a).length === 0) {
    throw new Error('createIdTokenVerifier requires jwksUrl, issuers and audiences.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('createIdTokenVerifier requires a fetch implementation.');
  const audienceList = audiences.filter((a) => typeof a === 'string' && a);

  let keys = new Map();
  let fetchedAt = -Infinity;
  let attemptedAt = -Infinity;
  let inflight = null;

  async function load() {
    attemptedAt = now();
    let body;
    try {
      const signal = typeof globalThis.AbortSignal?.timeout === 'function' ? globalThis.AbortSignal.timeout(timeoutMs) : undefined;
      const response = await fetchImpl(jwksUrl, signal ? { signal } : undefined);
      if (!response || !response.ok) throw new Error('status');
      body = await response.json();
    } catch (_error) {
      throw new IdTokenError('keys_unavailable', 'The identity provider keys could not be loaded.');
    }
    const next = new Map();
    for (const jwk of (body && Array.isArray(body.keys) ? body.keys : []).slice(0, MAX_KEYS)) {
      if (!jwk || typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
      if (jwk.use && jwk.use !== 'sig') continue;
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      } catch (_error) { /* une clé illisible est ignorée, les autres restent */ }
    }
    keys = next;
    fetchedAt = now();
  }

  function refresh() {
    if (!inflight) inflight = load().finally(() => { inflight = null; });
    return inflight;
  }

  async function keyFor(kid) {
    if (now() - fetchedAt >= cacheMs) {
      /* Un fournisseur muet n'est pas réinterrogé à chaque jeton : on garde les anciennes clés jusqu'au prochain essai permis. */
      if (now() - attemptedAt >= minRefreshMs || keys.size === 0) {
        try { await refresh(); } catch (error) { if (keys.size === 0) throw error; }
      }
    } else if (!keys.has(kid) && now() - attemptedAt >= minRefreshMs) {
      await refresh();
    }
    return keys.get(kid) || null;
  }

  /**
   * @param {string} idToken
   * @param {object} [expected]
   * @param {string|string[]} [expected.nonce]  la valeur exacte attendue dans le jeton (ou les valeurs acceptées).
   */
  return async function verifyIdToken(idToken, expected = {}) {
    if (typeof idToken !== 'string' || !idToken || idToken.length > MAX_TOKEN_LENGTH) {
      throw new IdTokenError('malformed');
    }
    const decoded = jwt.decode(idToken, { complete: true });
    const header = decoded && decoded.header;
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      throw new IdTokenError('malformed');
    }
    const key = await keyFor(header.kid);
    if (!key) throw new IdTokenError('unknown_key');

    let claims;
    try {
      claims = jwt.verify(idToken, key, {
        algorithms: ['RS256'],
        issuer: issuers,
        audience: audienceList,
        clockTimestamp: Math.floor(now() / 1000),
        clockTolerance: clockToleranceSec
      });
    } catch (error) {
      throw new IdTokenError(error && error.name === 'TokenExpiredError' ? 'expired' : 'invalid');
    }
    if (!claims || typeof claims !== 'object' || typeof claims.sub !== 'string' || !claims.sub) {
      throw new IdTokenError('invalid');
    }
    if (expected && expected.nonce !== undefined && expected.nonce !== null) {
      /* Plusieurs valeurs acceptées : le nonce brut et son empreinte, quand l'appelant ne sait pas
         si la bibliothèque de l'app a haché le nonce avant de le donner au fournisseur. */
      const accepted = (Array.isArray(expected.nonce) ? expected.nonce : [expected.nonce]).map(String).filter(Boolean);
      const got = Buffer.from(typeof claims.nonce === 'string' ? claims.nonce : '');
      const matches = accepted.some((value) => {
        const want = Buffer.from(value);
        return want.length === got.length && crypto.timingSafeEqual(want, got);
      });
      if (!matches) throw new IdTokenError('nonce_mismatch');
    }

    const email = typeof claims.email === 'string' && claims.email.includes('@') ? claims.email.trim().toLowerCase() : null;
    return {
      subject: claims.sub,
      email,
      emailVerified: Boolean(email) && truthy(claims.email_verified),
      relayEmail: truthy(claims.is_private_email) || (email ? email.endsWith('@privaterelay.appleid.com') : false),
      audience: Array.isArray(claims.aud) ? claims.aud[0] : claims.aud,
      claims
    };
  };
}

function createGoogleIdTokenVerifier({ audiences, ...options } = {}) {
  return createIdTokenVerifier({ jwksUrl: GOOGLE_JWKS_URL, issuers: GOOGLE_ISSUERS, audiences, ...options });
}

function createAppleIdTokenVerifier({ audiences, ...options } = {}) {
  return createIdTokenVerifier({ jwksUrl: APPLE_JWKS_URL, issuers: APPLE_ISSUERS, audiences, ...options });
}

module.exports = {
  createIdTokenVerifier,
  createGoogleIdTokenVerifier,
  createAppleIdTokenVerifier,
  hashNonce,
  IdTokenError,
  ID_TOKEN_ERROR_CODES,
  GOOGLE_JWKS_URL,
  GOOGLE_ISSUERS,
  APPLE_JWKS_URL,
  APPLE_ISSUERS
};
