/**
 * Knowing when an account is used from somewhere new, and saying so.
 *
 * Two alerts, one purpose: the person whose account is being taken over must
 * hear about it while there is still time to act.
 *
 * A NEW SIGN-IN DEVICE. "Device" is the user agent plus the network FAMILY of
 * the address — /16 in IPv4, /48 in IPv6. A finer family (/24) changed every
 * time a mobile carrier switched antenna: a parent got an alert a day for
 * their own phone, and an alert that rings every day is no longer read.
 * Nothing is kept in the clear, only an HMAC fingerprint, and a bounded number
 * per account (the least recently seen leave first).
 *
 * No alert on an account's very first sign-in: there is nothing to compare
 * with, and the person is the one who just created it.
 *
 * A SENSITIVE CHANGE — password, e-mail, sign-in factors. A code was sent to
 * AUTHORISE a change, but nothing confirmed it had happened; the victim learnt
 * it the day they could no longer sign in. The confirmation afterwards is the
 * one that protects. Two rules carry it:
 *
 *   1. An e-mail change is announced to the PREVIOUS address. The new one is
 *      already in the hands of whoever made the change: writing there warns
 *      nobody.
 *   2. A failed send NEVER fails the change. The password is already changed
 *      when we get here; an error would make the person believe otherwise, and
 *      they would retry with the old one.
 *
 * NO WORDS HERE. This module decides WHEN to warn and WHOM; the caller turns a
 * catalogue key and the account's locale into text, in its own language files.
 */

const crypto = require('crypto');

const DEFAULT_MAX_DEVICES = 8;
const MAX_USER_AGENT = 512;

/* ─────────────────────────── Address families ─────────────────────────── */

/** Expand an IPv6 literal to its eight groups, or null. */
function ipv6Groups(value) {
  let text = value.split('%')[0];
  /* An embedded IPv4 tail (::1.2.3.4) counts as two groups. */
  const v4 = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = text.slice(0, -v4[0].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => parseInt(group, 16).toString(16));
}

/**
 * The network family an address belongs to.
 *
 * IPv6 is EXPANDED before cutting. Splitting the literal on ':' gave
 * "2001:db8::5" and "2001:db8:0:1::5" two different families for the same
 * /48, so the same phone raised a "new device" alert depending on how its
 * address happened to be written.
 */
function ipFamily(ip) {
  const value = String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d)/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.').map(Number);
    if (parts.some((part) => part > 255)) return 'unknown';
    return `${parts[0]}.${parts[1]}.0.0/16`;
  }
  if (value.includes(':')) {
    const groups = ipv6Groups(value);
    if (!groups) return 'unknown';
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return 'unknown';
}

/* ─────────────────────────── Sign-in devices ─────────────────────────── */

/**
 * In-memory store. Dev and tests only.
 * Contract: upsert() must be ATOMIC — two simultaneous sign-ins from the same
 * device must yield exactly one `inserted: true`, or the person gets two alerts.
 * With MongoDB: updateOne({ accountId, fingerprint }, { $set, $setOnInsert },
 * { upsert: true }) and `inserted = upsertedCount === 1`, plus a unique index.
 */
function createMemoryLoginDeviceStore() {
  const rows = new Map();
  const key = (accountId, fingerprint) => `${accountId}\u0000${fingerprint}`;
  return {
    async upsert(accountId, fingerprint, at) {
      const existing = rows.get(key(accountId, fingerprint));
      if (existing) {
        existing.lastSeenAt = at;
        return { inserted: false };
      }
      rows.set(key(accountId, fingerprint), { accountId, fingerprint, firstSeenAt: at, lastSeenAt: at });
      return { inserted: true };
    },
    async count(accountId) {
      return [...rows.values()].filter((row) => row.accountId === accountId).length;
    },
    async keepMostRecent(accountId, keep) {
      const mine = [...rows.values()].filter((row) => row.accountId === accountId)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      for (const row of mine.slice(keep)) rows.delete(key(row.accountId, row.fingerprint));
    },
    async all() {
      return [...rows.values()].map((row) => ({ ...row }));
    }
  };
}

/**
 * @param {object} options
 * @param {object} options.store  upsert/count/keepMostRecent.
 * @param {string} options.secret  HMAC key for fingerprints — dedicated, not the
 *   session secret.
 * @param {(account: object, event: {type: 'new-login-device', at: number}) => Promise<void>} options.notify
 *   Tell the account holder. You pick the catalogue key and the locale.
 * @param {number} [options.maxDevices=8]
 * @param {(error: Error) => void} [options.onError]
 * @param {() => number} [options.now]
 */
function createLoginDeviceTracker(options = {}) {
  const { store, secret, notify } = options;
  if (!store || typeof store.upsert !== 'function' || typeof store.count !== 'function') {
    throw new Error('createLoginDeviceTracker requires options.store.');
  }
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('createLoginDeviceTracker requires options.secret.');
  }
  if (typeof notify !== 'function') throw new Error('createLoginDeviceTracker requires options.notify.');
  const maxDevices = options.maxDevices || DEFAULT_MAX_DEVICES;
  const onError = options.onError || (() => {});
  const now = options.now || Date.now;

  function fingerprint({ ip, userAgent } = {}) {
    const source = `${ipFamily(ip)}|${String(userAgent || 'unknown').slice(0, MAX_USER_AGENT)}`;
    return crypto.createHmac('sha256', secret).update(source).digest('hex');
  }

  /**
   * Call AFTER the session is granted. Never throws: the sign-in already
   * succeeded, and a tracking failure must not turn it into an error.
   *
   * @param {{id: *}} account  what `notify` receives back.
   * @returns {Promise<{isNew: boolean, firstDevice: boolean, notified: boolean, error?: true}>}
   */
  async function record(account, context = {}) {
    try {
      const accountId = String(account?.id ?? account?._id ?? '');
      if (!accountId) throw new Error('record requires account.id.');
      const at = now();
      const { inserted } = await store.upsert(accountId, fingerprint(context), at);
      if (!inserted) return { isNew: false, firstDevice: false, notified: false };

      const total = await store.count(accountId);
      if (total > maxDevices && typeof store.keepMostRecent === 'function') {
        await store.keepMostRecent(accountId, maxDevices);
      }
      if (total <= 1) return { isNew: true, firstDevice: true, notified: false };

      await notify(account, { type: 'new-login-device', at });
      return { isNew: true, firstDevice: false, notified: true };
    } catch (error) {
      onError(error);
      return { isNew: false, firstDevice: false, notified: false, error: true };
    }
  }

  return { record, fingerprint };
}

/* ─────────────────────────── Change alerts ─────────────────────────── */

const CHANGE_TYPES = Object.freeze([
  'password',
  'email',
  'factor-added',
  'factor-removed',
  'recovery-codes',
  'trusted-device'
]);

/**
 * @param {object} options
 * @param {(message: {to: string, key: string, locale?: string, change: string, detail?: string, account: object}) => Promise<unknown>} options.send
 *   Delivers the alert. `key` is `${keyPrefix}.${change}` — render subject and
 *   body from YOUR catalogue, in `locale`. Do not put an action link in it: a
 *   security alert must not teach people to click links received by e-mail.
 * @param {string} [options.keyPrefix='security.change']
 * @param {(account: object) => string|undefined} [options.localeOf]  default account.locale.
 * @param {(error: Error, change: string) => void} [options.onError]
 */
function createChangeAlerts(options = {}) {
  const send = options.send;
  if (typeof send !== 'function') throw new Error('createChangeAlerts requires options.send.');
  const keyPrefix = options.keyPrefix || 'security.change';
  const localeOf = options.localeOf || ((account) => account?.locale);
  const onError = options.onError || (() => {});

  /**
   * @param {object} account  the account that changed.
   * @param {string} change   one of CHANGE_TYPES.
   * @param {object} [input]
   * @param {string} [input.to]  where to warn — the account address. For
   *   'email', ignored: use previousEmail.
   * @param {string} [input.previousEmail]  'email' only: the address BEFORE.
   * @param {string} [input.newEmail]       'email' only: shown so the owner can
   *   recognise — or not — the address that replaced theirs.
   * @param {string} [input.detail]  e.g. the new device's name.
   * @returns {Promise<boolean>} whether the alert was handed over. Never throws.
   */
  async function alert(account, change, input = {}) {
    if (!CHANGE_TYPES.includes(change)) throw new Error(`Unknown change type: ${change}`);

    let to = input.to;
    let detail = input.detail;
    if (change === 'email') {
      /* A FIRST address has no predecessor to warn, and belongs to the person
         who just set it. */
      to = input.previousEmail;
      detail = input.newEmail;
      if (to && input.newEmail && String(to).toLowerCase() === String(input.newEmail).toLowerCase()) return false;
    }
    if (!to) return false;

    try {
      await send({ to: String(to), key: `${keyPrefix}.${change}`, locale: localeOf(account), change, detail, account });
      return true;
    } catch (error) {
      onError(error, change);
      return false;
    }
  }

  return { alert, CHANGE_TYPES };
}

/* ─────────────────────────── Operator alerts ─────────────────────────── */

const ALERT_LEVELS = Object.freeze(['INFO', 'WARN', 'ERROR', 'FATAL']);

/**
 * Fan an operator alert (not a user-facing one) out to every channel you
 * configured — webhook, dedicated mailbox, pager. One channel down must not
 * silence the others, and an alert failure must never break the request that
 * raised it.
 *
 * Send these to a DEDICATED mailbox, never the founder's personal one: an
 * automated flow into a main inbox ends up ignored, and exposes the admin
 * account in automated mail headers.
 *
 * @param {object} options
 * @param {Array<(alert: object) => Promise<unknown>>} options.channels
 * @param {(line: string, alert: object) => void} [options.log]
 * @param {() => number} [options.now]
 */
function createSecurityAlerter(options = {}) {
  const channels = Array.isArray(options.channels) ? options.channels.filter((fn) => typeof fn === 'function') : [];
  const log = options.log || (() => {});
  const now = options.now || Date.now;

  /** @returns {Promise<boolean>} true when at least one channel delivered. */
  async function send({ level = 'WARN', type = 'security', subject, message, meta = {} } = {}) {
    const alertEvent = {
      level: ALERT_LEVELS.includes(level) ? level : 'WARN',
      type: String(type),
      subject: subject || type,
      message,
      meta,
      timestamp: new Date(now()).toISOString()
    };
    log(`[${alertEvent.level}] ${alertEvent.type}`, alertEvent);
    if (channels.length === 0) return false;
    const results = await Promise.allSettled(channels.map((channel) => Promise.resolve().then(() => channel(alertEvent))));
    return results.some((result) => result.status === 'fulfilled' && result.value !== false);
  }

  return { send };
}

module.exports = {
  ipFamily,
  createMemoryLoginDeviceStore,
  createLoginDeviceTracker,
  createChangeAlerts,
  createSecurityAlerter,
  CHANGE_TYPES,
  ALERT_LEVELS,
  DEFAULT_MAX_LOGIN_DEVICES: DEFAULT_MAX_DEVICES
};
