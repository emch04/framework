/**
 * Self-service account deletion, reversible during a grace period.
 *
 * App stores require that a person can delete their own account without
 * writing to support. Doing it in one irreversible click is the wrong answer
 * twice over: it punishes an impulsive tap, and it hands whoever borrowed a
 * session the power to destroy the account for good.
 *
 * So the request SUSPENDS the account at once — open sessions fall, the caller
 * decides what else stops — and the erasure only happens once the grace period
 * is over. Signing back in during the period, or cancelling from the settings,
 * brings the account back. An attacker who wants the account gone has to keep
 * the owner away from it for the whole period.
 *
 * This module does not know how to erase. The erasure is injected — typically
 * the anonymizer of this same package — because a second definition of
 * "erased" would drift from the first the day one of them learns a new field.
 *
 * Every transition is a compare-and-set on the store. Two instances running
 * the sweep, or a sign-in landing in the middle of it, must not both win.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 30 * DAY_MS;
const DEFAULT_REMINDER_MS = 3 * DAY_MS;
/* A claim older than this was left by an instance that died mid-erasure. The
   erasure is expected to be idempotent, so taking it over is safe. */
const DEFAULT_STALE_CLAIM_MS = 60 * 60 * 1000;
/* Held just under a daily schedule: releasing at the end would let an
   instance whose timer fires a few seconds later run the same pass again. */
const DEFAULT_LOCK_HOLD_MS = 23 * 60 * 60 * 1000;

const SCHEDULED = 'scheduled';
const ERASING = 'erasing';
const ERASED = 'erased';

/** Machine-readable refusals. The client translates them; no prose here. */
const DELETION_REASONS = {
  ALREADY_REQUESTED: 'already_requested',
  ALREADY_ERASED: 'already_erased',
  NOT_FOUND: 'not_found',
  ERASURE_IN_PROGRESS: 'erasure_in_progress'
};

/** How the pending deletion was cancelled — the notification may differ. */
const CANCELLED_BY = { USER: 'user', SIGN_IN: 'sign-in' };

const time = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/**
 * Is the erasure due?
 *
 * Deliberately tolerant of a missing date: answering "yes" by default would
 * erase at once an account marked for deletion WITHOUT a deadline. Answering
 * "no" leaves the anomaly visible in the store rather than in a lost account.
 */
function isDeletionDue(record, now = new Date()) {
  const deadline = record && record.scheduledFor;
  if (!deadline) return false;
  const at = time(deadline);
  if (!Number.isFinite(at)) return false;
  return at <= time(now);
}

function assertDeletionStore(store) {
  for (const method of ['get', 'create', 'update', 'remove', 'list']) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`createAccountDeletion requires options.store.${method}().`);
    }
  }
}

function positiveDuration(value, fallback, name) {
  if (value === undefined) return fallback;
  if (value === null && name === 'reminderMs') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`createAccountDeletion: options.${name} must be a positive number of milliseconds.`);
  }
  return value;
}

/**
 * @param {object} options
 * @param {object} options.store   { get, create, update, remove, list } — see
 *   createMemoryDeletionStore() for the contract.
 * @param {Function} options.erase async (subject, record) => any. Must be
 *   idempotent: a pass that died half-way runs it again.
 * @param {number} [options.graceMs]     default 30 days.
 * @param {number|null} [options.reminderMs] how long before the deadline the
 *   last warning goes out. Default 3 days; null disables it.
 * @param {Function} [options.canRequest] async (subject, context) => reason
 *   string to refuse, or null to allow. Where product rules live ("the last
 *   administrator cannot leave", "this account is not deletable").
 * @param {Function} [options.suspend]   async (subject, record) => void. Runs
 *   right after the request: revoke sessions, trusted devices, push tokens.
 * @param {Function} [options.restore]   async (subject, record) => void, on cancel.
 * @param {object} [options.notify]      { send(subject, message, event), messages }
 *   `messages.scheduled | cancelled | reminder | erased` are functions
 *   (context) => message. The package never writes the text.
 * @param {object} [options.lock]  anything with run(name, holdMs, fn) that
 *   resolves null when another instance holds it — @astratra/resilience's
 *   createJobLock() fits as is.
 * @param {string} [options.lockName]
 * @param {number} [options.lockHoldMs]
 * @param {number} [options.staleClaimMs]
 * @param {Function} [options.now]
 * @param {object} [options.logger]
 */
function createAccountDeletion(options = {}) {
  const store = options.store;
  assertDeletionStore(store);

  const erase = options.erase;
  if (typeof erase !== 'function') {
    throw new Error('createAccountDeletion requires options.erase.');
  }

  const graceMs = positiveDuration(options.graceMs, DEFAULT_GRACE_MS, 'graceMs');
  const reminderMs = positiveDuration(options.reminderMs, DEFAULT_REMINDER_MS, 'reminderMs');
  const staleClaimMs = positiveDuration(options.staleClaimMs, DEFAULT_STALE_CLAIM_MS, 'staleClaimMs');
  const lockHoldMs = positiveDuration(options.lockHoldMs, DEFAULT_LOCK_HOLD_MS, 'lockHoldMs');
  const lockName = options.lockName || 'account-deletion-sweep';
  const lock = options.lock || null;
  if (lock && typeof lock.run !== 'function') {
    throw new Error('createAccountDeletion: options.lock must provide run(name, holdMs, fn).');
  }

  const canRequest = options.canRequest || null;
  const suspend = options.suspend || null;
  const restore = options.restore || null;
  const now = options.now || (() => new Date());
  const logger = options.logger || { info() {}, error() {} };

  const notify = options.notify || null;
  if (notify && typeof notify.send !== 'function') {
    throw new Error('createAccountDeletion: options.notify.send is required when notify is given.');
  }
  const messages = (notify && notify.messages) || {};

  /**
   * Send one notification. Returns whether it went out.
   *
   * A failed e-mail must never undo the request or the cancellation it
   * reports: the person would be told nothing AND the state would be wrong.
   * It is logged and reported as not sent.
   */
  async function send(subject, event, context) {
    const build = messages[event];
    if (!notify || typeof build !== 'function') return false;
    try {
      const result = await notify.send(subject, build(context), event);
      return result !== false;
    } catch (error) {
      logger.error(`[privacy] deletion notice "${event}" failed: ${error.message}`);
      return false;
    }
  }

  const daysLeft = (record, at) => Math.max(1, Math.ceil((time(record.scheduledFor) - time(at)) / DAY_MS));

  /**
   * The person asks for their account to be deleted. Nothing is erased yet.
   *
   * @returns {Promise<{ok: true, record: object} | {ok: false, reason: string}>}
   */
  async function request(subject, context = {}) {
    if (subject === undefined || subject === null || subject === '') {
      throw new Error('A deletion request needs a subject.');
    }

    const existing = await store.get(subject);
    if (existing) {
      return { ok: false, reason: existing.status === ERASED ? DELETION_REASONS.ALREADY_ERASED : DELETION_REASONS.ALREADY_REQUESTED };
    }

    if (canRequest) {
      const refusal = await canRequest(subject, context);
      if (refusal) return { ok: false, reason: String(refusal) };
    }

    const requestedAt = now();
    const record = {
      subject,
      status: SCHEDULED,
      requestedAt,
      scheduledFor: new Date(time(requestedAt) + graceMs),
      reminderFor: null,
      erasingSince: null,
      erasedAt: null,
      attempts: 0,
      lastError: null
    };

    /* The insert itself is the uniqueness check. Reading first and writing
       after lets two taps on a slow network both pass the read — and the
       second one would push the deadline further every time. */
    const created = await store.create(record);
    if (!created) return { ok: false, reason: DELETION_REASONS.ALREADY_REQUESTED };

    if (suspend) {
      try {
        await suspend(subject, record);
      } catch (error) {
        /* A deletion the person believes has closed their account, while
           their sessions stay open, is worse than a request that fails
           visibly. Undo and let them retry. */
        await store.remove(subject, { status: SCHEDULED, requestedAt }).catch(() => {});
        logger.error(`[privacy] deletion request rolled back, suspension failed: ${error.message}`);
        throw error;
      }
    }

    logger.info('[privacy] account deletion scheduled');
    await send(subject, 'scheduled', { subject, requestedAt, scheduledFor: record.scheduledFor, daysLeft: daysLeft(record, requestedAt) });
    return { ok: true, record: { ...record } };
  }

  /**
   * Bring the account back. Only a SCHEDULED deletion can be cancelled: once
   * the erasure has started, there is nothing left to bring back.
   *
   * @returns {Promise<{cancelled: boolean, reason?: string}>}
   */
  async function cancel(subject, { by = CANCELLED_BY.USER } = {}) {
    const existing = await store.get(subject);
    if (!existing) return { cancelled: false, reason: DELETION_REASONS.NOT_FOUND };
    if (existing.status !== SCHEDULED) {
      return {
        cancelled: false,
        reason: existing.status === ERASED ? DELETION_REASONS.ALREADY_ERASED : DELETION_REASONS.ERASURE_IN_PROGRESS
      };
    }

    /* Conditional on the state we just read: if a sweep claimed the record in
       between, the cancellation loses instead of reporting a rescue that did
       not happen. */
    const removed = await store.remove(subject, { status: SCHEDULED, scheduledFor: existing.scheduledFor });
    if (!removed) return { cancelled: false, reason: DELETION_REASONS.ERASURE_IN_PROGRESS };

    if (restore) {
      try {
        await restore(subject, existing);
      } catch (error) {
        logger.error(`[privacy] restore after cancellation failed: ${error.message}`);
      }
    }

    logger.info(`[privacy] account deletion cancelled (${by})`);
    /* A sign-in by someone else must not bring the account back silently:
       the owner hears about every cancellation. */
    await send(subject, 'cancelled', { subject, by, requestedAt: existing.requestedAt, scheduledFor: existing.scheduledFor });
    return { cancelled: true };
  }

  /**
   * Call once a session is REALLY granted — password checked AND the second
   * factor when one is due. Calling it after the password alone would let
   * someone who only knows the password resurrect an account without the key.
   *
   * Never throws: a person must not be locked out by the mechanism meant to
   * let them back in. A failure is logged and reported.
   */
  async function onSignIn(subject) {
    try {
      return await cancel(subject, { by: CANCELLED_BY.SIGN_IN });
    } catch (error) {
      logger.error(`[privacy] cancellation at sign-in failed: ${error.message}`);
      return { cancelled: false, error };
    }
  }

  /** What the settings screen shows. */
  async function status(subject) {
    const record = await store.get(subject);
    if (!record) return { pending: false, erased: false, requestedAt: null, scheduledFor: null };
    return {
      pending: record.status !== ERASED,
      erased: record.status === ERASED,
      requestedAt: record.requestedAt || null,
      scheduledFor: record.scheduledFor || null
    };
  }

  /** For an auth middleware: a pending deletion keeps the account suspended. */
  async function isSuspended(subject) {
    const record = await store.get(subject);
    return Boolean(record);
  }

  /**
   * The last warning, once per deadline. The reservation is written BEFORE
   * the send: the lock covers the cluster, the compare-and-set covers a lock
   * that expired mid-pass. A failed send frees the reservation for next time.
   */
  async function sendReminders(at) {
    if (reminderMs === null || !notify || typeof messages.reminder !== 'function') return 0;
    const upcoming = await store.list({
      status: SCHEDULED,
      scheduledFor: { gt: at, lte: new Date(time(at) + reminderMs) }
    });
    let sent = 0;
    for (const record of upcoming) {
      if (record.reminderFor && time(record.reminderFor) === time(record.scheduledFor)) continue;
      const reserved = await store.update(
        record.subject,
        { status: SCHEDULED, scheduledFor: record.scheduledFor, reminderFor: record.reminderFor || null },
        { reminderFor: record.scheduledFor }
      );
      if (!reserved) continue;
      const ok = await send(record.subject, 'reminder', {
        subject: record.subject,
        requestedAt: record.requestedAt,
        scheduledFor: record.scheduledFor,
        daysLeft: daysLeft(record, at)
      });
      if (ok) sent += 1;
      else await store.update(record.subject, { status: SCHEDULED, reminderFor: record.scheduledFor }, { reminderFor: null });
    }
    return sent;
  }

  async function eraseOne(record, at, expected) {
    /* Claim first. Between the listing and this line the person may have
       signed in: erasing on the strength of a stale read would destroy an
       account its owner just brought back. */
    const claimed = await store.update(record.subject, expected, { status: ERASING, erasingSince: at });
    if (!claimed) return 'skipped';

    try {
      await erase(record.subject, record);
    } catch (error) {
      /* Back to scheduled with its deadline untouched: it is retried on the
         next pass, and a failure is never recorded as an erasure. */
      await store.update(record.subject, { status: ERASING, erasingSince: at }, {
        status: SCHEDULED,
        erasingSince: null,
        attempts: (record.attempts || 0) + 1,
        lastError: error.message
      });
      logger.error(`[privacy] account erasure failed, retried next pass: ${error.message}`);
      return 'failed';
    }

    await store.update(record.subject, { status: ERASING, erasingSince: at }, {
      status: ERASED,
      erasedAt: at,
      erasingSince: null,
      lastError: null
    });
    await send(record.subject, 'erased', { subject: record.subject, requestedAt: record.requestedAt, erasedAt: at });
    return 'erased';
  }

  async function runSweep() {
    const at = now();
    let reminded = 0;
    try {
      reminded = await sendReminders(at);
    } catch (error) {
      /* A reminder problem must not hold the erasures back. */
      logger.error(`[privacy] deletion reminders failed: ${error.message}`);
    }

    const due = (await store.list({ status: SCHEDULED, scheduledFor: { lte: at } }))
      .filter((record) => isDeletionDue(record, at));
    const stale = await store.list({ status: ERASING, erasingSince: { lte: new Date(time(at) - staleClaimMs) } });

    const counts = { erased: 0, failed: 0, skipped: 0 };
    for (const record of due) {
      counts[await eraseOne(record, at, { status: SCHEDULED, scheduledFor: record.scheduledFor })] += 1;
    }
    for (const record of stale) {
      counts[await eraseOne(record, at, { status: ERASING, erasingSince: record.erasingSince })] += 1;
    }

    if (counts.erased) logger.info(`[privacy] ${counts.erased} account(s) erased after the grace period`);
    return { ran: true, reminded, ...counts };
  }

  /**
   * The periodic pass: last warnings, then erasures that are due.
   * Idempotent — a second pass finds nothing left to do.
   */
  async function sweep() {
    if (!lock) return runSweep();
    const result = await lock.run(lockName, lockHoldMs, runSweep);
    /* null is the lock's way of saying another instance has this pass. */
    return result === null || result === undefined
      ? { ran: false, reminded: 0, erased: 0, failed: 0, skipped: 0 }
      : result;
  }

  return { request, cancel, onSignIn, status, isSuspended, sweep, graceMs, reminderMs };
}

module.exports = {
  createAccountDeletion,
  isDeletionDue,
  DELETION_REASONS,
  CANCELLED_BY,
  DELETION_SCHEDULED: SCHEDULED,
  DELETION_ERASING: ERASING,
  DELETION_ERASED: ERASED,
  DEFAULT_GRACE_MS
};
