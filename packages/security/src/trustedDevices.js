/**
 * Signing back in with the phone's own lock — Face ID, a fingerprint, the
 * device code — instead of the password, on a device that already signed in.
 *
 * WHY A ROTATED SECRET AND NOT A KEY PAIR. A key pair only helps if the
 * private key stays inside the phone's secure chip and signs only after the
 * biometric check — which needs a native module. In JavaScript the private key
 * would sit in the same keystore as a secret, and be stolen the same way. A
 * secret rotated on every use gives something a pair does not: a copied
 * secret that is replayed SHOWS, because one of the two uses presents a
 * fingerprint that was already spent.
 *
 * The guarantees, each one a rule below:
 *
 *  - the server keeps an HMAC fingerprint only (server-side pepper): a copy of
 *    the database signs nobody in;
 *  - a device is enrolled from a COMPLETE session only — second factor
 *    included when the account requires it;
 *  - each exchange spends the secret ATOMICALLY (safe across a cluster, no
 *    in-process state) and hands back a new one;
 *  - a spent secret coming back kills the device and — through `onReplay` —
 *    every session of the account: we cannot tell which of the two holders is
 *    the owner, so both lose;
 *  - the device is bound to the credential in force at enrolment: a password
 *    changed by ANY path, even one written later that forgets to revoke,
 *    switches it off;
 *  - it dies after `idleTtlMs` without use, on revocation, on removal;
 *  - attempts per device are bounded;
 *  - every failure is the SAME error, so a prober learns nothing.
 */

const crypto = require('crypto');

const DEFAULT_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DEVICES = 5;
/* Enough to recognise the replay of a secret stolen weeks ago, without the row
   growing on every sign-in. */
const DEFAULT_KEPT_FINGERPRINTS = 30;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const DEVICE_ID_PATTERN = /^[a-f0-9]{32}$/;
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const PLATFORMS = ['ios', 'android', 'web'];

class TrustedDeviceError extends Error {
  /**
   * @param {'TRUSTED_DEVICE_REJECTED'|'TRUSTED_DEVICE_THROTTLED'|'SECOND_FACTOR_REQUIRED'} code
   */
  constructor(code, extra = {}) {
    super(code);
    this.name = 'TrustedDeviceError';
    this.code = code;
    this.statusCode = code === 'TRUSTED_DEVICE_THROTTLED' ? 429 : code === 'SECOND_FACTOR_REQUIRED' ? 403 : 401;
    Object.assign(this, extra);
  }
}

const rejected = () => new TrustedDeviceError('TRUSTED_DEVICE_REJECTED');

function sameText(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/* Shown back to the owner in a list and in an alert: no control characters,
   no markup, bounded. */
const cleanName = (value) => [...String(value ?? '')]
  .filter((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f && char !== '<' && char !== '>')
  .join('').trim().slice(0, 80);
const cleanPlatform = (value) => (PLATFORMS.includes(value) ? value : 'other');

/**
 * In-memory store. Dev and tests only.
 *
 * `consume` is the one method that must be atomic in a real store: it swaps
 * the current fingerprint ONLY if it is still the expected one. With MongoDB:
 * updateOne({ _id, secretHash: expected, revokedAt: null }, { $set, $push:
 * { previousHashes: { $each: [expected], $slice: -kept } } }) and
 * `modifiedCount === 1`.
 */
function createMemoryTrustedDeviceStore() {
  const rows = new Map();
  const copy = (row) => (row ? { ...row, previousHashes: [...row.previousHashes] } : null);
  return {
    async create(record) {
      rows.set(record.id, { ...record, previousHashes: [] });
      return copy(rows.get(record.id));
    },
    async findByDeviceId(deviceId) {
      for (const row of rows.values()) if (row.deviceId === deviceId) return copy(row);
      return null;
    },
    async consume(id, expectedHash, next) {
      const row = rows.get(id);
      if (!row || row.revokedAt || row.secretHash !== expectedHash) return false;
      row.previousHashes = [...row.previousHashes, expectedHash].slice(-next.keep);
      row.secretHash = next.secretHash;
      row.lastUsedAt = next.lastUsedAt;
      row.expiresAt = next.expiresAt;
      return true;
    },
    async revoke(filter, reason, at, keepUntil) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.revokedAt) continue;
        if (filter.id !== undefined && ![].concat(filter.id).includes(row.id)) continue;
        if (filter.accountId !== undefined && row.accountId !== filter.accountId) continue;
        if (filter.deviceId !== undefined && row.deviceId !== filter.deviceId) continue;
        if (filter.secretHash !== undefined && row.secretHash !== filter.secretHash) continue;
        row.revokedAt = at;
        row.revokedReason = reason;
        row.expiresAt = keepUntil;
        count += 1;
      }
      return count;
    },
    async listActive(accountId) {
      return [...rows.values()].filter((row) => row.accountId === accountId && !row.revokedAt).map(copy);
    },
    async all() {
      return [...rows.values()].map(copy);
    }
  };
}

/**
 * Fixed-window attempt counter. Memory version for tests and single-process
 * dev; in a cluster, back it with Redis (INCR + PEXPIRE) so four processes do
 * not grant four times the attempts.
 */
function createMemoryAttemptCounter() {
  const windows = new Map();
  return {
    async hit(key, windowMs, at) {
      const current = windows.get(key);
      if (!current || current.resetAt <= at) {
        windows.set(key, { count: 1, resetAt: at + windowMs });
        return { count: 1, resetAt: at + windowMs };
      }
      current.count += 1;
      return { ...current };
    }
  };
}

/**
 * @param {object} options
 * @param {object} options.store     createMemoryTrustedDeviceStore() or yours.
 * @param {string} options.pepper    server-side HMAC key, dedicated, >= 32 chars.
 * @param {object} [options.attempts] hit(key, windowMs, at) — default in memory.
 * @param {number} [options.maxAttempts=10]  exchanges per device per window.
 * @param {number} [options.attemptWindowMs=15 min]
 * @param {number} [options.idleTtlMs=30 days]
 * @param {number} [options.maxDevices=5]
 * @param {number} [options.keptFingerprints=30]
 * @param {number} [options.retentionAfterRevokeMs=30 days]  revoked rows are
 *   kept that long — a replay of their old secret is then still recognised.
 * @param {(event: {accountId: string, id: string, at: number}) => Promise<void>} [options.onReplay]
 *   Revoke every session of the account and alert. Awaited; a failure is
 *   reported through onError and does not un-revoke the device.
 * @param {(error: Error) => void} [options.onError]
 * @param {() => number} [options.now]
 */
function createTrustedDeviceService(options = {}) {
  const store = options.store;
  for (const method of ['create', 'findByDeviceId', 'consume', 'revoke', 'listActive']) {
    if (!store || typeof store[method] !== 'function') throw new Error(`createTrustedDeviceService requires store.${method}.`);
  }
  const pepper = options.pepper;
  if (typeof pepper !== 'string' || pepper.length < 32) {
    throw new Error('createTrustedDeviceService requires options.pepper (at least 32 characters).');
  }
  const attempts = options.attempts || createMemoryAttemptCounter();
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const attemptWindowMs = options.attemptWindowMs || DEFAULT_ATTEMPT_WINDOW_MS;
  const idleTtlMs = options.idleTtlMs || DEFAULT_IDLE_TTL_MS;
  const maxDevices = options.maxDevices || DEFAULT_MAX_DEVICES;
  const keep = options.keptFingerprints || DEFAULT_KEPT_FINGERPRINTS;
  const retentionMs = options.retentionAfterRevokeMs || DEFAULT_RETENTION_MS;
  const onReplay = options.onReplay || (async () => {});
  const onError = options.onError || (() => {});
  const now = options.now || Date.now;

  /* Two domains under one pepper: a secret's fingerprint can never be
     confused with a credential stamp. */
  const fingerprint = (secret) => crypto.createHmac('sha256', pepper).update(`device:${secret}`).digest('hex');
  const credentialBinding = (stamp) => crypto.createHmac('sha256', pepper).update(`credential:${String(stamp ?? '')}`).digest('hex');

  const revoke = (filter, reason, at = now()) => store.revoke(filter, reason, at, at + retentionMs);

  /**
   * Enrol THIS device for the signed-in account.
   *
   * @param {object} input
   * @param {string} input.accountId
   * @param {string} input.credentialStamp  something that changes whenever the
   *   password changes — the stored password HASH is the natural choice.
   * @param {boolean} [input.requireSecondFactor]  the account's policy.
   * @param {boolean} [input.secondFactorVerified]  what THIS session proved.
   * @param {string} [input.deviceName]
   * @param {string} [input.platform]  ios | android | web
   * @returns {Promise<{id: string, deviceId: string, secret: string, expiresAt: number}>}
   *   Hand deviceId + secret to the device ONCE; they are never shown again.
   */
  async function enroll(input = {}) {
    const accountId = String(input.accountId || '');
    if (!accountId) throw new Error('enroll requires accountId.');
    if (input.credentialStamp === undefined || input.credentialStamp === null || input.credentialStamp === '') {
      throw new Error('enroll requires credentialStamp.');
    }
    /* A door that lasts a month is not opened by a half-finished session,
       even if a middleware upstream is supposed to have refused it already. */
    if (input.requireSecondFactor && input.secondFactorVerified !== true) {
      throw new TrustedDeviceError('SECOND_FACTOR_REQUIRED');
    }

    const at = now();
    const deviceId = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const record = {
      id: crypto.randomUUID(),
      accountId,
      deviceId,
      secretHash: fingerprint(secret),
      secondFactorVerified: input.secondFactorVerified === true,
      credentialBinding: credentialBinding(input.credentialStamp),
      deviceName: cleanName(input.deviceName),
      platform: cleanPlatform(input.platform),
      createdAt: at,
      lastUsedAt: at,
      expiresAt: at + idleTtlMs,
      revokedAt: null,
      revokedReason: null
    };
    await store.create(record);

    /* Bounded: a stolen session cannot seed devices without limit. The least
       recently used leaves first. */
    const active = (await store.listActive(accountId)).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const excess = active.slice(maxDevices).map((row) => row.id);
    if (excess.length) await revoke({ id: excess }, 'limit', at);

    return { id: record.id, deviceId, secret, expiresAt: record.expiresAt };
  }

  /**
   * Trade the device's secret for a new one. On success, issue the session
   * yourself — with the same checks as a password sign-in (suspended account,
   * pending deletion…) — and, if you refuse it, call revoke(result.id,
   * 'session-refused').
   *
   * @param {{deviceId: string, secret: string}} proof
   * @param {object} context
   * @param {(accountId: string) => Promise<{credentialStamp: *, disabled?: boolean}|null>} context.loadAccount
   * @returns {Promise<{id: string, accountId: string, deviceId: string, secret: string,
   *   secondFactorVerified: boolean, expiresAt: number}>}
   * @throws {TrustedDeviceError} REJECTED for every failure, THROTTLED past the limit.
   */
  async function exchange(proof = {}, { loadAccount } = {}) {
    if (typeof loadAccount !== 'function') throw new Error('exchange requires context.loadAccount.');
    const { deviceId, secret } = proof || {};
    if (typeof deviceId !== 'string' || typeof secret !== 'string'
      || !DEVICE_ID_PATTERN.test(deviceId) || !SECRET_PATTERN.test(secret)) throw rejected();

    const at = now();
    /* Counted BEFORE any lookup, success or not: the secret is 256 bits, the
       bound is there so a script cannot hammer one device to trigger
       revocations or flood the audit log. */
    const hit = await attempts.hit(`trusted-device:${deviceId}`, attemptWindowMs, at);
    if (hit.count > maxAttempts) {
      throw new TrustedDeviceError('TRUSTED_DEVICE_THROTTLED', { retryAfterMs: Math.max(0, hit.resetAt - at) });
    }

    const device = await store.findByDeviceId(deviceId);
    if (!device) throw rejected();

    const presented = fingerprint(secret);
    const current = sameText(presented, device.secretHash);
    const spent = !current && (device.previousHashes || []).some((hash) => sameText(hash, presented));

    if (device.revokedAt || !(device.expiresAt > at)) throw rejected();

    if (spent) {
      await replayDetected(device, at);
      throw rejected();
    }
    if (!current) throw rejected();

    const account = await loadAccount(device.accountId);
    if (!account || account.disabled || !sameText(device.credentialBinding, credentialBinding(account.credentialStamp))) {
      await revoke({ id: device.id }, account ? 'account-changed' : 'account-missing', at);
      throw rejected();
    }

    /* Spend the secret ONCE, before anything is issued. Two simultaneous
       exchanges of the same secret: one wins, the other is a replay. */
    const nextSecret = crypto.randomBytes(32).toString('hex');
    const won = await store.consume(device.id, device.secretHash, {
      secretHash: fingerprint(nextSecret),
      lastUsedAt: at,
      expiresAt: at + idleTtlMs,
      keep
    });
    if (!won) {
      await replayDetected(device, at);
      throw rejected();
    }

    return {
      id: device.id,
      accountId: device.accountId,
      deviceId: device.deviceId,
      secret: nextSecret,
      secondFactorVerified: device.secondFactorVerified === true,
      expiresAt: at + idleTtlMs
    };
  }

  async function replayDetected(device, at) {
    await revoke({ id: device.id }, 'replay', at);
    try {
      await onReplay({ accountId: device.accountId, id: device.id, at });
    } catch (error) {
      onError(error);
    }
  }

  /**
   * "Forget this account on this device", with no session: the secret is the
   * proof. Silent either way — the answer never says whether anything matched.
   */
  async function forget(proof = {}) {
    const { deviceId, secret } = proof || {};
    if (typeof deviceId !== 'string' || typeof secret !== 'string'
      || !DEVICE_ID_PATTERN.test(deviceId) || !SECRET_PATTERN.test(secret)) return;
    await revoke({ deviceId, secretHash: fingerprint(secret) }, 'forgotten');
  }

  /** What the owner sees: never the secret, its fingerprint, nor the lookup key. */
  async function list(accountId) {
    const at = now();
    const rows = await store.listActive(String(accountId));
    return rows
      .filter((row) => row.expiresAt > at)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((row) => ({
        id: row.id,
        deviceName: row.deviceName || '',
        platform: row.platform || 'other',
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        expiresAt: row.expiresAt
      }));
  }

  /** Remove ONE device of the signed-in account. False if it is not theirs. */
  async function remove(accountId, id) {
    if (!accountId || !id) return false;
    const count = await revoke({ id: String(id), accountId: String(accountId) }, 'removed');
    return Number(count) > 0;
  }

  /** Every device of the account falls: password changed, sessions revoked, account closing. */
  function revokeAll(accountId, reason = 'revoked') {
    return revoke({ accountId: String(accountId) }, reason);
  }

  return {
    enroll,
    exchange,
    forget,
    list,
    remove,
    revokeAll,
    revoke: (id, reason = 'revoked') => revoke({ id: String(id) }, reason),
    fingerprint
  };
}

module.exports = {
  TrustedDeviceError,
  createTrustedDeviceService,
  createMemoryTrustedDeviceStore,
  createMemoryAttemptCounter,
  TRUSTED_DEVICE_ID_PATTERN: DEVICE_ID_PATTERN,
  TRUSTED_DEVICE_SECRET_PATTERN: SECRET_PATTERN
};
