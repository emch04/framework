/**
 * Staying signed in, without leaving a skeleton key lying around.
 *
 * An access token is deliberately short-lived — that brevity is what limits
 * the damage of a theft. The price is that something has to renew it, and that
 * something is a long-lived credential. Get it wrong and you have replaced a
 * one-hour risk with a one-month one.
 *
 * Four decisions carry this module.
 *
 * IT IS NOT A JWT. A refresh token proves nothing by itself and carries no
 * claims: it is an opaque random string, meaningful only as a row in a store.
 * That is what makes it REVOCABLE — a signed token is valid until it expires,
 * whatever you would prefer.
 *
 * IT IS STORED AS A FINGERPRINT, NEVER IN THE CLEAR. A stolen database then
 * yields no sessions at all. The token has full entropy, so a plain SHA-256 is
 * the right hash here: there is nothing to brute-force, and a slow hash on
 * every refresh would only be a denial-of-service surface.
 *
 * IT ROTATES ON EVERY USE. The token presented is SPENT, and a new one takes
 * its place. A token seen twice is therefore an anomaly, not a normal case —
 * which is the whole point of the next rule.
 *
 * A REPLAY KILLS THE FAMILY. When a spent token comes back, someone kept a
 * copy: the legitimate client has already moved on. Refusing just that one
 * token would leave the thief holding the CURRENT one, so the entire chain
 * descending from that sign-in is revoked. The real person signs in again —
 * an inconvenience that is the correct price for a stolen session.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class RefreshTokenError extends Error {
  /**
   * @param {string} message
   * @param {'REFRESH_TOKEN_INVALID'|'REFRESH_TOKEN_EXPIRED'|'REFRESH_TOKEN_REUSED'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'RefreshTokenError';
    this.code = code;
  }
}

function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * The store contract, in memory. Dev and tests only: sessions vanish on
 * restart, which means everyone is signed out by a deploy.
 */
function createMemoryRefreshTokenStore() {
  const records = new Map();

  return {
    async save(record) {
      records.set(record.id, { ...record });
      return { ...record };
    },
    async findByHash(hash) {
      for (const record of records.values()) {
        if (record.hash === hash) return { ...record };
      }
      return null;
    },
    async markConsumed(id, at) {
      const record = records.get(id);
      if (record) record.consumedAt = at;
    },
    async revokeFamily(familyId, at) {
      for (const record of records.values()) {
        if (record.familyId === familyId) record.revokedAt = record.revokedAt || at;
      }
    },
    async revokeAllForUser(userId, at) {
      for (const record of records.values()) {
        if (record.userId === userId) record.revokedAt = record.revokedAt || at;
      }
    },
    async deleteExpired(before) {
      let removed = 0;
      for (const [id, record] of records) {
        if (record.expiresAt <= before) {
          records.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    /** Test and inspection helper — not part of the contract adapters must meet. */
    async all() {
      return [...records.values()].map((record) => ({ ...record }));
    }
  };
}

/**
 * @param {object} options
 * @param {object} options.store  save/findByHash/markConsumed/revokeFamily/
 *   revokeAllForUser/deleteExpired. The memory one above, or your database.
 * @param {number} [options.ttlMs]  Lifetime of each token. Default 30 days.
 * @param {Function} [options.now]  Clock, for tests.
 * @param {Function} [options.randomToken]  Token factory, for tests.
 */
function createRefreshTokenService(options = {}) {
  const store = options.store;
  if (!store || typeof store.findByHash !== 'function' || typeof store.save !== 'function') {
    throw new Error('createRefreshTokenService requires options.store.');
  }

  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const now = options.now || Date.now;
  /*
   * HEX, not base64url — and this cost a real bug to learn.
   *
   * base64url contains '-', so roughly one token in 130 carried a '--'
   * somewhere. The WAF reads '--' in a request body as an SQL comment and
   * answers 403, so that session could NEVER be renewed: the client retries
   * the same token, gets blocked again, and the person is signed out for
   * reasons nobody can reproduce.
   *
   * A credential must never be readable as content. Hex has no character any
   * filter takes an interest in, and 32 random bytes carry the same entropy
   * whichever alphabet prints them.
   */
  const randomToken = options.randomToken || (() => crypto.randomBytes(32).toString('hex'));

  async function mint({ userId, familyId }) {
    const token = randomToken();
    const issuedAt = now();
    const record = {
      id: crypto.randomUUID(),
      familyId: familyId || crypto.randomUUID(),
      userId: String(userId),
      hash: fingerprint(token),
      createdAt: issuedAt,
      /* Counted from NOW on every rotation: an active session should not die
         because it was first opened a month ago. */
      expiresAt: issuedAt + ttlMs,
      consumedAt: null,
      revokedAt: null
    };
    await store.save(record);
    return { token, id: record.id, familyId: record.familyId, userId: record.userId, expiresAt: record.expiresAt };
  }

  /** A fresh sign-in: a new family of its own. */
  async function issue({ userId } = {}) {
    if (!userId) throw new Error('issue requires userId.');
    return mint({ userId });
  }

  /**
   * Exchange a token for the next one.
   * @throws {RefreshTokenError} invalid, expired, or replayed.
   */
  async function rotate(token) {
    if (typeof token !== 'string' || !token) {
      throw new RefreshTokenError('Unknown refresh token.', 'REFRESH_TOKEN_INVALID');
    }

    const record = await store.findByHash(fingerprint(token));
    if (!record) throw new RefreshTokenError('Unknown refresh token.', 'REFRESH_TOKEN_INVALID');

    if (record.revokedAt) {
      throw new RefreshTokenError('This session has been revoked.', 'REFRESH_TOKEN_INVALID');
    }

    /* Checked BEFORE expiry: a replayed token that also happens to have
       expired is still a theft, and must still kill the family. */
    if (record.consumedAt) {
      await store.revokeFamily(record.familyId, now());
      throw new RefreshTokenError(
        'Refresh token replayed — every session from this sign-in has been revoked.',
        'REFRESH_TOKEN_REUSED'
      );
    }

    if (record.expiresAt <= now()) {
      throw new RefreshTokenError('This session has expired.', 'REFRESH_TOKEN_EXPIRED');
    }

    await store.markConsumed(record.id, now());
    return mint({ userId: record.userId, familyId: record.familyId });
  }

  /** Sign out one device: that chain, and nothing else. */
  async function revokeFamily(familyId) {
    await store.revokeFamily(familyId, now());
  }

  /** Password changed, account recovered: everything this person holds dies. */
  async function revokeAllForUser(userId) {
    await store.revokeAllForUser(String(userId), now());
  }

  /** Housekeeping — call it on a timer. Returns how many rows were dropped. */
  async function prune() {
    if (typeof store.deleteExpired !== 'function') return 0;
    return store.deleteExpired(now());
  }

  return { issue, rotate, revokeFamily, revokeAllForUser, prune, fingerprint };
}

module.exports = {
  RefreshTokenError,
  createMemoryRefreshTokenStore,
  createRefreshTokenService
};
