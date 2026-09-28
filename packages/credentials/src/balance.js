/**
 * What is left on a provider account, read at the provider, shown next to its key.
 *
 * Some providers sell a quota that runs out — worse, some free tiers never
 * renew. Without the number on the settings screen, you learn the service is
 * gone the day it stops answering, and whatever depended on it degrades in
 * silence. So the screen that manages a key also says how much it has left.
 *
 * The package knows no provider's API. Each key that can be probed brings its
 * own `read(value)` — an injected fetch underneath, never a hard-wired client —
 * and this module does the rest the same way for all of them:
 *
 *   - the value comes from the vault, so the key typed in the interface is the
 *     one probed, never a stale one left in the environment;
 *   - a failed reading is SAID, with a code. A number is never invented — an
 *     "about 2,400" from memory is exactly the silent failure this exists to
 *     prevent;
 *   - readings are cached. A balance does not move by the second and a probe
 *     can cost a request; a failed one is kept for less time, so a hiccup does
 *     not hide the number for long, while a dead provider is not hammered each
 *     time someone opens the screen;
 *   - two screens asking at once share one request.
 *
 * The key never leaves in a result, a log line or an error: not its value, not
 * a fingerprint, not its length. A digest is kept in memory only, to notice
 * that the key changed and the cached reading no longer describes it.
 */
const crypto = require('crypto');

const OK = 'ok';
const LOW = 'low';
const EMPTY = 'empty';
const UNKNOWN = 'unknown';
const ERROR = 'error';

const BALANCE_STATUSES = Object.freeze([OK, LOW, EMPTY, UNKNOWN, ERROR]);

/** Why a reading failed. Codes, never prose: the screen translates them. */
const BALANCE_ERRORS = Object.freeze({
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  REJECTED: 'rejected',
  UNREADABLE: 'unreadable',
  NO_BALANCE: 'no_balance',
  FAILED: 'failed'
});

const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_ERROR_CACHE_MS = 30 * 1000;
const DEFAULT_MIN_REFRESH_MS = 10 * 1000;
const DEFAULT_TIMEOUT_MS = 6000;

const NOOP_LOGGER = { warn() {} };

/** A failed reading, carrying a code and — for a refusal — the HTTP status. */
class BalanceProbeError extends Error {
  constructor(code, detail = {}) {
    super(`balance probe failed: ${code}`);
    this.name = 'BalanceProbeError';
    this.code = code;
    if (Number.isInteger(detail.httpStatus)) this.httpStatus = detail.httpStatus;
  }
}

/**
 * The status of a balance against its thresholds.
 *
 * `critical` is a second, stricter line under `low`: "keep an eye on it" and
 * "act now" are not the same message. At or under zero is empty, whatever the
 * thresholds say.
 */
function classifyBalance(balance, thresholds = {}) {
  if (typeof balance !== 'number' || !Number.isFinite(balance)) return { status: ERROR, critical: false };
  if (balance <= 0) return { status: EMPTY, critical: true };
  const low = Number.isFinite(thresholds.low) ? thresholds.low : null;
  const critical = Number.isFinite(thresholds.critical) ? thresholds.critical : null;
  if (critical !== null && balance < critical) return { status: LOW, critical: true };
  if (low !== null && balance < low) return { status: LOW, critical: false };
  return { status: OK, critical: false };
}

function validateThresholds(key, thresholds) {
  if (!thresholds) return {};
  const { low, critical } = thresholds;
  for (const [name, value] of [['low', low], ['critical', critical]]) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`createBalanceProbe: thresholds.${name} for "${key}" must be a non-negative number.`);
    }
  }
  if (low !== undefined && critical !== undefined && critical > low) {
    throw new Error(`createBalanceProbe: thresholds.critical for "${key}" cannot exceed thresholds.low.`);
  }
  return { ...(low !== undefined ? { low } : {}), ...(critical !== undefined ? { critical } : {}) };
}

/** Anything a probe throws, reduced to a code. The message is never kept: it may quote the request. */
function codeOf(error) {
  if (error && Object.values(BALANCE_ERRORS).includes(error.code)) return error.code;
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return BALANCE_ERRORS.TIMEOUT;
  return BALANCE_ERRORS.FAILED;
}

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * @param {object} options
 * @param {Record<string, object>} options.probes  key name -> {
 *     read(value, { signal }) -> { balance, rateLimit?, limit? },
 *     thresholds?: { low?, critical? }, unit?: string, renewable?: boolean,
 *     timeoutMs?: number }
 * @param {object} [options.vault]     anything with get(key) — the credential vault.
 * @param {Function} [options.getValue] (key) => value, instead of a vault.
 * @param {object} [options.catalog]   when given, every probed key must be in it.
 * @param {number} [options.cacheMs]      how long a reading holds. Default 5 min.
 * @param {number} [options.errorCacheMs] how long a failed reading holds. Default 30 s.
 * @param {number} [options.minRefreshMs] a forced refresh closer than this to the
 *   last reading is served from the cache. Default 10 s.
 * @param {Function} [options.now]
 * @param {object} [options.logger]  { warn } — key name and code only.
 */
function createBalanceProbe(options = {}) {
  const probes = options.probes && typeof options.probes === 'object' ? options.probes : null;
  if (!probes || !Object.keys(probes).length) {
    throw new Error('createBalanceProbe requires at least one probe in options.probes.');
  }

  let readValue;
  if (typeof options.getValue === 'function') readValue = options.getValue;
  else if (options.vault && typeof options.vault.get === 'function') readValue = (key) => options.vault.get(key);
  else throw new Error('createBalanceProbe requires options.vault (with get) or options.getValue.');

  const catalog = options.catalog || null;
  const definitions = new Map();
  for (const [key, probe] of Object.entries(probes)) {
    if (!probe || typeof probe.read !== 'function') {
      throw new Error(`createBalanceProbe: the probe for "${key}" needs a read(value) function.`);
    }
    if (catalog && typeof catalog.has === 'function' && !catalog.has(key)) {
      throw new Error(`createBalanceProbe: "${key}" is not in the credential catalog.`);
    }
    definitions.set(key, {
      read: probe.read,
      thresholds: validateThresholds(key, probe.thresholds),
      unit: probe.unit || null,
      renewable: probe.renewable === undefined ? null : Boolean(probe.renewable),
      timeoutMs: probe.timeoutMs || DEFAULT_TIMEOUT_MS
    });
  }

  const cacheMs = options.cacheMs === undefined ? DEFAULT_CACHE_MS : options.cacheMs;
  const errorCacheMs = options.errorCacheMs === undefined ? DEFAULT_ERROR_CACHE_MS : options.errorCacheMs;
  const minRefreshMs = options.minRefreshMs === undefined ? DEFAULT_MIN_REFRESH_MS : options.minRefreshMs;
  const now = options.now || (() => Date.now());
  const logger = options.logger || NOOP_LOGGER;

  /* key -> { fingerprint, report, at } */
  const cache = new Map();
  /* key -> { fingerprint, promise } */
  const inFlight = new Map();

  function report(key, fields) {
    const definition = definitions.get(key);
    return {
      key,
      status: fields.status,
      critical: Boolean(fields.critical),
      balance: fields.balance === undefined ? null : fields.balance,
      rateLimit: fields.rateLimit === undefined ? null : fields.rateLimit,
      limit: fields.limit === undefined ? null : fields.limit,
      unit: definition.unit,
      renewable: definition.renewable,
      code: fields.code || null,
      checkedAt: fields.checkedAt || null
    };
  }

  async function probe(key, value) {
    const definition = definitions.get(key);
    const checkedAt = new Date(now()).toISOString();
    let reading;
    try {
      reading = await definition.read(value, { signal: globalThis.AbortSignal.timeout(definition.timeoutMs) });
    } catch (error) {
      const code = codeOf(error);
      logger.warn(`[credentials] balance of ${key} unreadable: ${code}`);
      return report(key, { status: ERROR, code, checkedAt });
    }
    const balance = reading && reading.balance;
    if (typeof balance !== 'number' || !Number.isFinite(balance)) {
      logger.warn(`[credentials] balance of ${key} unreadable: ${BALANCE_ERRORS.NO_BALANCE}`);
      return report(key, { status: ERROR, code: BALANCE_ERRORS.NO_BALANCE, checkedAt });
    }
    const { status, critical } = classifyBalance(balance, definition.thresholds);
    const number = (field) => (typeof reading[field] === 'number' && Number.isFinite(reading[field]) ? reading[field] : null);
    return report(key, { status, critical, balance, rateLimit: number('rateLimit'), limit: number('limit'), checkedAt });
  }

  /**
   * The balance behind one key. Never rejects.
   * @param {string} key
   * @param {{ refresh?: boolean }} [opts] bypass the cache (bounded by minRefreshMs).
   */
  async function check(key, opts = {}) {
    if (!definitions.has(key)) return null;

    let value = null;
    try {
      value = await readValue(key);
    } catch (_error) {
      /* The vault does not throw on a read; a custom getValue might. */
      logger.warn(`[credentials] balance of ${key}: key unreadable`);
      return report(key, { status: ERROR, code: BALANCE_ERRORS.FAILED });
    }
    /* No key, or one deliberately unplugged: nothing to probe. That is a fact
       about the key, not a failed reading — and it is never cached, so a key
       typed a second later is probed at once. */
    if (!value) {
      cache.delete(key);
      return report(key, { status: UNKNOWN });
    }

    const fingerprint = digest(value);
    const cached = cache.get(key);
    if (cached && cached.fingerprint === fingerprint) {
      const age = now() - cached.at;
      const ttl = cached.report.status === ERROR ? errorCacheMs : cacheMs;
      const fresh = age < ttl;
      if (fresh && !opts.refresh) return { ...cached.report };
      if (opts.refresh && age < minRefreshMs) return { ...cached.report };
    }

    const running = inFlight.get(key);
    if (running && running.fingerprint === fingerprint) return { ...(await running.promise) };

    const promise = probe(key, value).then((result) => {
      cache.set(key, { fingerprint, report: result, at: now() });
      return result;
    }).finally(() => {
      if (inFlight.get(key) && inFlight.get(key).promise === promise) inFlight.delete(key);
    });
    inFlight.set(key, { fingerprint, promise });
    return { ...(await promise) };
  }

  /** Several keys at once — every probed key by default. */
  async function checkAll(keys, opts = {}) {
    const names = (Array.isArray(keys) ? keys : [...definitions.keys()]).filter((key) => definitions.has(key));
    const results = await Promise.all(names.map((key) => check(key, opts)));
    return Object.fromEntries(names.map((key, index) => [key, results[index]]));
  }

  /** Drop the cached reading — after the key changed, for instance. */
  function forget(key) {
    if (key === undefined) cache.clear();
    else cache.delete(key);
  }

  return {
    check,
    checkAll,
    forget,
    has: (key) => definitions.has(key),
    keys: () => [...definitions.keys()]
  };
}

/* ─────────────────────────── Serper, the first built-in probe ─────────────────────────── */

const SERPER_ACCOUNT_URL = 'https://google.serper.dev/account';

/**
 * Serper's free tier is a one-off stock of credits that never renews: the
 * provider this module was written for. Thresholds are the ones chosen when
 * the stock was 2,500 credits; pass your own for a paid plan.
 */
const SERPER_THRESHOLDS = Object.freeze({ low: 600, critical: 200 });

/**
 * Reads the credits left on a Serper account. The account endpoint consumes
 * no credit. Throws a BalanceProbeError with a code; never puts the key in it.
 *
 * @param {object} options
 * @param {Function} options.fetch  a WHATWG fetch — injected, never global by surprise.
 * @param {string} [options.url]
 */
function createSerperBalanceReader(options = {}) {
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('createSerperBalanceReader requires options.fetch.');
  }
  const url = options.url || SERPER_ACCOUNT_URL;

  return async function readSerperBalance(apiKey, { signal } = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'X-API-KEY': String(apiKey), 'Content-Type': 'application/json' },
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new BalanceProbeError(BALANCE_ERRORS.TIMEOUT);
      }
      throw new BalanceProbeError(BALANCE_ERRORS.UNREACHABLE);
    }
    if (!response || response.status !== 200) {
      throw new BalanceProbeError(BALANCE_ERRORS.REJECTED, { httpStatus: response && response.status });
    }
    let data;
    try {
      data = await response.json();
    } catch (_error) {
      throw new BalanceProbeError(BALANCE_ERRORS.UNREADABLE);
    }
    if (!data || typeof data.balance !== 'number' || !Number.isFinite(data.balance)) {
      throw new BalanceProbeError(BALANCE_ERRORS.NO_BALANCE);
    }
    return {
      balance: data.balance,
      rateLimit: typeof data.rateLimit === 'number' && Number.isFinite(data.rateLimit) ? data.rateLimit : null
    };
  };
}

/** A ready probe definition for createBalanceProbe({ probes: { SERPER_API_KEY: serperBalanceProbe({ fetch }) } }). */
function serperBalanceProbe(options = {}) {
  return {
    read: createSerperBalanceReader(options),
    thresholds: options.thresholds || SERPER_THRESHOLDS,
    unit: 'credits',
    renewable: options.renewable === undefined ? false : Boolean(options.renewable),
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS
  };
}

module.exports = {
  createBalanceProbe,
  classifyBalance,
  BalanceProbeError,
  BALANCE_STATUSES,
  BALANCE_ERRORS,
  BALANCE_OK: OK,
  BALANCE_LOW: LOW,
  BALANCE_EMPTY: EMPTY,
  BALANCE_UNKNOWN: UNKNOWN,
  BALANCE_ERROR: ERROR,
  createSerperBalanceReader,
  serperBalanceProbe,
  SERPER_ACCOUNT_URL,
  SERPER_THRESHOLDS
};
