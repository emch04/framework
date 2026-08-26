/**
 * The pair of tokens, kept where a phone keeps secrets.
 *
 * Two decisions here are worth stating, because both came from a real defect.
 *
 * THE ACCESS TOKEN IS CACHED IN MEMORY. Reading the keystore is a native
 * round-trip, and every single request needs the token. Reading it from the
 * Keychain on each call turned a list screen's twelve parallel requests into
 * twelve Keychain reads.
 *
 * CLEARING TAKES THE BIOMETRIC FLAG WITH IT. The flag says "this person chose
 * to unlock with their face" — it belongs to the session that enabled it. Left
 * behind at logout, it stays on for whoever signs in next on the same device,
 * a stranger included.
 *
 * The keystore may fail: a locked Keychain, a revoked permission, a browser
 * with storage disabled. A read that throws is answered as "no session" — the
 * person signs in again, which is bad, while a crash at launch is worse.
 */

const ACCESS = 'auth.token';
const REFRESH = 'auth.refreshToken';
const BIOMETRIC = 'biometric.enabled';

/** Namespaced so two apps — or an app and its staging twin — never collide. */
function keyOf(namespace, suffix) {
  return `${namespace}.${suffix}`;
}

/**
 * @param {object} options
 * @param {object} options.keystore  getItemAsync/setItemAsync/deleteItemAsync.
 *   expo-secure-store as-is, or one of this package's adapters.
 * @param {string} [options.namespace='app']  Prefix for every stored key.
 * @returns {object} the session handle.
 */
function createSecureSession(options = {}) {
  const keystore = options.keystore;
  if (!keystore || typeof keystore.getItemAsync !== 'function') {
    throw new Error('createSecureSession requires options.keystore with getItemAsync/setItemAsync/deleteItemAsync.');
  }

  const namespace = options.namespace || 'app';
  const accessKey = keyOf(namespace, ACCESS);
  const refreshKey = keyOf(namespace, REFRESH);
  const biometricKey = keyOf(namespace, BIOMETRIC);

  let cachedAccess = null;

  async function read(key) {
    try {
      const value = await keystore.getItemAsync(key);
      return value === undefined ? null : value;
    } catch {
      return null;
    }
  }

  async function write(key, value) {
    try {
      await keystore.setItemAsync(key, value);
    } catch {
      /* an unwritable keystore costs the next launch, not this one */
    }
  }

  async function remove(key) {
    try {
      await keystore.deleteItemAsync(key);
    } catch {
      /* same */
    }
  }

  return {
    keys: Object.freeze({ access: accessKey, refresh: refreshKey, biometric: biometricKey }),

    /** The bearer token, from memory after the first read. */
    async getAccessToken() {
      if (cachedAccess === null) cachedAccess = await read(accessKey);
      return cachedAccess;
    },

    /** The refresh token. Never cached: it is used once, when a request 401s. */
    async getRefreshToken() {
      return read(refreshKey);
    },

    /**
     * Store a fresh pair. A refresh response that returns only an access token
     * must NOT wipe the refresh token — omitting it leaves the stored one.
     */
    async save({ accessToken, refreshToken } = {}) {
      if (accessToken) {
        cachedAccess = String(accessToken);
        await write(accessKey, cachedAccess);
      }
      if (refreshToken) await write(refreshKey, String(refreshToken));
    },

    /** Sign out: both tokens and the biometric choice, everywhere. */
    async clear() {
      cachedAccess = null;
      await Promise.all([remove(accessKey), remove(refreshKey), remove(biometricKey)]);
    },

    /** Drop the in-memory copy without touching the keystore. Tests, mostly. */
    forget() {
      cachedAccess = null;
    }
  };
}

module.exports = { createSecureSession };
