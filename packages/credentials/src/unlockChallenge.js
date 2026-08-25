/**
 * The one-time code that authorises a key change.
 *
 * The principle: knowing the account password is not enough — you must also be
 * able to read the account's inbox. Replacing a payment key with your own
 * breaks nothing visible; the money simply goes somewhere else. That is the
 * kind of theft you only notice on a statement.
 *
 * This module knows nothing about email. It generates, stores and checks the
 * code; `deliverCode` is yours, and it is where you decide whether the code
 * travels by mail, SMS or anything else. Deliver it to the address ALREADY on
 * the account, never to one supplied in the request — that would hand a thief
 * the means to send it to themselves.
 */
const crypto = require('crypto');
const AppError = require('@astratra/core').AppError;
const { assertAdapter } = require('./utils');

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;   // the code expires in ten minutes
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;     // and then opens ten minutes of editing
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RESEND_DELAY_MS = 60 * 1000;    // at most one send per minute

/* Math.random() is fine for a display code. Not here: these six digits protect
   what collects your payments, and a predictable generator is guessable. */
function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/** Constant-time comparison: the response time must reveal nothing. */
function sameHash(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * @param {object} options
 * @param {object} options.store        challenge store adapter (find, save).
 * @param {Function} options.deliverCode async ({ subjectId, code, expiresInMs }) => any.
 * @param {number} [options.codeTtlMs]
 * @param {number} [options.windowMs]
 * @param {number} [options.maxAttempts]
 * @param {number} [options.resendDelayMs]
 * @param {Function} [options.now]      () => epoch ms, for tests.
 */
function createUnlockChallenge(options = {}) {
  const store = options.store;
  assertAdapter(store, ['find', 'save'], 'options.store');

  const deliverCode = options.deliverCode;
  if (typeof deliverCode !== 'function') {
    throw new Error('createUnlockChallenge requires options.deliverCode.');
  }

  const codeTtlMs = options.codeTtlMs || DEFAULT_CODE_TTL_MS;
  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const resendDelayMs = options.resendDelayMs === undefined ? DEFAULT_RESEND_DELAY_MS : options.resendDelayMs;
  const now = options.now || (() => Date.now());

  const asTime = (value) => (value ? new Date(value).getTime() : 0);

  /** Generate a code and hand it to your delivery function. */
  async function requestCode(subjectId) {
    const at = now();
    const existing = await store.find(subjectId);

    if (existing?.lastRequestedAt && at - asTime(existing.lastRequestedAt) < resendDelayMs) {
      throw new AppError('A code was just sent. Wait a minute before asking for another.', 429);
    }

    const code = newCode();
    await store.save(subjectId, {
      codeHash: hash(code),
      codeExpiresAt: new Date(at + codeTtlMs),
      attempts: 0,
      lastRequestedAt: new Date(at),
      /* Asking for a new code CLOSES the window currently open: otherwise a
         stolen session would ride the window you just opened yourself. */
      unlockedUntil: null
    });

    const delivery = await deliverCode({ subjectId, code, expiresInMs: codeTtlMs });
    return { ...(delivery || {}), expiresInMs: codeTtlMs };
  }

  /** Check the code and open the editing window. */
  async function verifyCode(subjectId, code) {
    const record = await store.find(subjectId);
    const invalid = () => new AppError('That code is wrong or has expired. Ask for a new one.', 400);

    if (!record?.codeHash || asTime(record.codeExpiresAt) < now()) throw invalid();

    if ((record.attempts || 0) >= maxAttempts) {
      /* The code is dead: erase it so no later attempt can succeed. */
      await store.save(subjectId, { ...record, codeHash: null, codeExpiresAt: null });
      throw new AppError('Too many attempts. Ask for a new code.', 429);
    }

    if (!sameHash(hash(code), record.codeHash)) {
      await store.save(subjectId, { ...record, attempts: (record.attempts || 0) + 1 });
      throw invalid();
    }

    /* The code has served; it will not serve again. */
    const unlockedUntil = new Date(now() + windowMs);
    await store.save(subjectId, {
      ...record,
      codeHash: null,
      codeExpiresAt: null,
      attempts: 0,
      unlockedUntil
    });

    return { unlockedUntil };
  }

  /** Is the window open? Returns the deadline, or null. */
  async function unlockedUntil(subjectId) {
    const record = await store.find(subjectId);
    const until = record?.unlockedUntil ? new Date(record.unlockedUntil) : null;
    return until && until.getTime() > now() ? until : null;
  }

  /** Refuse the change while the window is closed. */
  async function assertUnlocked(subjectId) {
    if (await unlockedUntil(subjectId)) return;
    throw new AppError('Request the emailed code before changing a key.', 403);
  }

  return {
    requestCode,
    verifyCode,
    unlockedUntil,
    assertUnlocked,
    codeTtlMs,
    windowMs,
    maxAttempts,
    resendDelayMs
  };
}

module.exports = {
  createUnlockChallenge,
  DEFAULT_CODE_TTL_MS,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RESEND_DELAY_MS
};
