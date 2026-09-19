/**
 * Idempotency keys: the same intention, sent twice, runs once.
 *
 * A double tap on "Pay", a mobile app replaying its offline queue, a proxy
 * retrying after a timeout: each of these sends the same write again. Without
 * a key, the server cannot tell a retry from a new request, and the customer
 * pays twice or is registered twice. The client generates ONE key per
 * intention (not per attempt) and sends it with every attempt; the server runs
 * the first and hands every later attempt the stored answer of the first.
 *
 * Four properties make this safe, and each one was a real bug somewhere:
 *
 *   THE CLAIM IS ATOMIC. The record is inserted "if absent" BEFORE the work
 *   runs, and that insertion decides who runs. A read followed by a write lets
 *   two simultaneous requests both see "nothing yet" and both execute.
 *
 *   A KEY IS BOUND TO ITS PAYLOAD. The same key with a different body is a
 *   caller bug, and is refused (422). Serving the stored answer of another
 *   request in silence would tell the caller its NEW request succeeded.
 *   The comparison is unconditional: a stored hash compared "only when both
 *   sides have one" lets a body-less request collect someone's answer.
 *
 *   ONLY SUCCESSES ARE KEPT. A stored 500 would turn a passing outage into a
 *   permanent refusal: the client would replay forever and receive the same
 *   error, and the write would never happen. Failures release the key.
 *
 *   THE CALLER IS PART OF THE KEY. Two accounts sending the same key must
 *   never receive each other's answer. The identity must be STABLE across
 *   token refreshes: fingerprinting the access token itself made a replay sent
 *   after a refresh look like a new request, and it ran a second time.
 *
 * Storage and retention are injected; an in-memory store ships for tests.
 */
const crypto = require('crypto');
const apiResponse = require('./apiResponse');

const IN_FLIGHT = 'in_flight';
const DONE = 'done';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
/* Long enough to be unique, short enough to be sane, and an alphabet that can
   travel into a database query without being interpreted. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const DEFAULT_MESSAGES = {
  invalid_key: 'Invalid Idempotency-Key header.',
  in_flight: 'A request with this idempotency key is already in progress.',
  conflict: 'This idempotency key was already used for a different request.',
  unavailable: 'Idempotency store unavailable; the request was not executed.'
};

class IdempotencyError extends Error {
  constructor(reason, statusCode, message) {
    super(message || reason);
    this.name = 'IdempotencyError';
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

/*
 * Key order must not matter: `{a:1,b:2}` and `{b:2,a:1}` are the same
 * intention. A plain JSON.stringify hashes them differently and turns an
 * honest retry (re-serialised by another client library) into a 422.
 */
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (typeof value.toJSON === 'function') return stableStringify(value.toJSON());
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashIdempotencyPayload(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/*
 * The record id: a hash of the caller's scope plus the key. Hashing gives a
 * fixed-length, separator-free id — joining raw parts with "|" lets a crafted
 * part collide with another caller's id.
 */
function idempotencyId(scope, key) {
  return crypto.createHash('sha256').update(JSON.stringify([...scope.map(String), String(key)])).digest('hex');
}

function isValidIdempotencyKey(key, pattern = KEY_PATTERN) {
  return typeof key === 'string' && pattern.test(key);
}

const timeOf = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/**
 * What to do with an existing record. Pure: no store, no clock of its own.
 *
 *   expired  — past its retention: not a retry any more, a new intention.
 *   conflict — same key, different payload.
 *   inFlight — the first attempt is still running: refuse rather than run twice.
 *   replay   — done: hand back the stored answer, run nothing.
 */
function decideIdempotency({ record, payloadHash, now = Date.now() }) {
  if (!record) return { action: 'execute' };
  if (timeOf(record.expiresAt) <= now) return { action: 'expired' };
  /* Conflict BEFORE in-flight: a different payload is a caller bug whatever
     the state of the first one, and saying so is more useful than "wait". */
  if (record.payloadHash !== payloadHash) return { action: 'conflict' };
  if (record.status !== DONE) return { action: 'inFlight' };
  return { action: 'replay', response: record.response };
}

const NOOP_LOGGER = { error() {}, warn() {} };

/**
 * @param {object} options
 * @param {object} options.store  adapter:
 *   acquire(id, entry) -> { acquired: boolean, record } — ATOMIC insert-if-absent;
 *     `record` is the existing one when not acquired.
 *   complete(id, token, response) — only if the record still carries `token`.
 *   release(id, token)            — delete, only if the record still carries `token`.
 *   Expired records may linger (a TTL index purges on its own schedule): the
 *   engine detects them and releases them itself.
 * @param {number} [options.ttlMs]  retention; default 24h.
 */
function createIdempotency(options = {}) {
  const store = options.store;
  for (const method of ['acquire', 'complete', 'release']) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`createIdempotency requires options.store.${method}().`);
    }
  }
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('createIdempotency: options.ttlMs must be a positive number of milliseconds.');
  }
  const now = options.now || (() => Date.now());
  const keyPattern = options.keyPattern || KEY_PATTERN;
  const messages = { ...DEFAULT_MESSAGES, ...(options.messages || {}) };
  const logger = options.logger || NOOP_LOGGER;

  const fail = (reason, statusCode) => new IdempotencyError(reason, statusCode, messages[reason]);

  /**
   * Claim the key. Returns either a replay, or a ticket that MUST be settled
   * with finish(response) or abort().
   */
  async function begin({ scope, key, payload } = {}) {
    if (!Array.isArray(scope) || scope.length === 0) {
      throw new Error('idempotency.begin requires a non-empty scope (at least the caller identity).');
    }
    if (!isValidIdempotencyKey(key, keyPattern)) throw fail('invalid_key', 400);

    const id = idempotencyId(scope, key);
    const payloadHash = hashIdempotencyPayload(payload);

    /* Two rounds at most: the second only happens after releasing an expired
       record. Losing the race again means someone else just claimed it. */
    for (let round = 0; round < 2; round += 1) {
      const at = now();
      const entry = {
        id,
        token: crypto.randomUUID(),
        status: IN_FLIGHT,
        payloadHash,
        response: null,
        createdAt: new Date(at),
        expiresAt: new Date(at + ttlMs)
      };

      const { acquired, record } = await store.acquire(id, entry);
      if (acquired) return ticket(id, entry.token);

      const verdict = decideIdempotency({ record, payloadHash, now: at });
      if (verdict.action === 'expired') {
        /* A TTL index purges on its own schedule (MongoDB: every minute). A
           lingering expired record must not block the key with "in progress"
           until then. The release is conditional on ITS token, so a fresh
           record claimed by a concurrent request is never deleted. */
        await store.release(id, record.token);
        continue;
      }
      if (verdict.action === 'conflict') throw fail('conflict', 422);
      if (verdict.action === 'inFlight') throw fail('in_flight', 409);
      return { action: 'replay', response: verdict.response };
    }
    throw fail('in_flight', 409);
  }

  function ticket(id, token) {
    let settled = false;
    return {
      action: 'execute',
      id,
      async finish(response) {
        if (settled) return;
        settled = true;
        await store.complete(id, token, response === undefined ? null : response);
      },
      async abort() {
        if (settled) return;
        settled = true;
        await store.release(id, token);
      }
    };
  }

  /**
   * Run `fn` once per (scope, key). Outside HTTP: jobs, queue consumers, RPC.
   *
   * A store failure AFTER `fn` ran is logged, not thrown: the work happened,
   * and reporting it as failed would invite the caller to do it again.
   */
  async function run(input, fn, { remember = () => true } = {}) {
    const claim = await begin(input);
    if (claim.action === 'replay') return { replayed: true, result: claim.response };

    let result;
    try {
      result = await fn();
    } catch (error) {
      await claim.abort().catch((e) => logger.error(`[idempotency] release failed: ${e.message}`));
      throw error;
    }

    try {
      if (remember(result)) await claim.finish(result);
      else await claim.abort();
    } catch (e) {
      logger.error(`[idempotency] could not settle key after execution: ${e.message}`);
    }
    return { replayed: false, result };
  }

  return { begin, run, ttlMs };
}

/**
 * In-process store for tests and development. Not persistent, and NOT shared
 * across instances: two processes each keep their own memory, so a retry that
 * reaches the other one runs again. Production needs a shared store with an
 * atomic insert (a unique _id, SET NX, INSERT ... ON CONFLICT DO NOTHING).
 */
function createMemoryIdempotencyStore(options = {}) {
  const rows = new Map();
  const now = options.now || (() => Date.now());
  const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

  /* A map that only grows is a memory leak with a long fuse: expired rows go,
     the way a TTL index would remove them. */
  function sweep() {
    const at = now();
    for (const [id, row] of rows) if (timeOf(row.expiresAt) <= at) rows.delete(id);
  }

  return {
    async acquire(id, entry) {
      sweep();
      /* No await between the check and the set: in one process, this is the
         atomic insert-if-absent. */
      if (rows.has(id)) return { acquired: false, record: clone(rows.get(id)) };
      rows.set(id, clone(entry));
      return { acquired: true, record: clone(entry) };
    },
    async complete(id, token, response) {
      const row = rows.get(id);
      if (!row || row.token !== token) return false;
      row.status = DONE;
      row.response = clone(response);
      return true;
    },
    async release(id, token) {
      const row = rows.get(id);
      if (!row || row.token !== token) return false;
      rows.delete(id);
      return true;
    },
    get(id) {
      return clone(rows.get(id)) || null;
    },
    size: () => rows.size
  };
}

const defaultRespond = (res, { status, message }) => apiResponse(res, status, message, null, false);
const isSuccess = (statusCode) => Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;

function headerOf(req, name) {
  const headers = req.headers || {};
  const value = headers[name] !== undefined ? headers[name] : headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function setHeader(res, name, value) {
  if (typeof res.setHeader === 'function') res.setHeader(name, value);
  else if (typeof res.set === 'function') res.set(name, value);
}

/**
 * The Express side.
 *
 * WITHOUT the header, nothing happens: idempotency is offered to clients that
 * ask for it, never imposed, so it can be deployed before any client uses it.
 *
 * @param {object} options  everything createIdempotency takes, plus:
 * @param {Function} options.identify  REQUIRED. (req) => a STABLE caller id
 *   (the account id, not the token). Mount the middleware AFTER authentication
 *   or verify the credential yourself inside `identify`: an unverified id lets
 *   anyone claim someone else's identity and collect their stored answer.
 *   Returning null puts the call in a shared anonymous namespace, where only
 *   the key and the payload separate callers.
 * @param {'deny'|'allow'} [options.onStoreError]  default 'deny' (503). 'allow'
 *   runs the request unguarded when the store is down: availability over the
 *   risk of a duplicate. Choose it knowingly — on a payment route it is the
 *   duplicate you were trying to prevent.
 */
function idempotencyMiddleware(options = {}) {
  const identify = options.identify;
  if (typeof identify !== 'function') {
    throw new Error('idempotencyMiddleware requires options.identify(req) — a stable caller id.');
  }
  const engine = options.engine || createIdempotency(options);
  const header = (options.header || 'idempotency-key').toLowerCase();
  const methods = new Set((options.methods || UNSAFE_METHODS).map((m) => m.toUpperCase()));
  const replayHeader = options.replayHeader || 'Idempotent-Replay';
  const remember = options.remember || isSuccess;
  const onStoreError = options.onStoreError || 'deny';
  const respond = options.respond || defaultRespond;
  const messages = { ...DEFAULT_MESSAGES, ...(options.messages || {}) };
  const logger = options.logger || NOOP_LOGGER;

  return async function idempotency(req, res, next) {
    const key = headerOf(req, header);
    if (!key || !methods.has(String(req.method || '').toUpperCase())) return next();

    let identity;
    try {
      identity = await identify(req);
    } catch (error) {
      return next(error);
    }

    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const scope = [identity === undefined || identity === null ? 'anonymous' : `id:${identity}`, req.method.toUpperCase(), path];

    let claim;
    try {
      claim = await engine.begin({ scope, key, payload: req.body });
    } catch (error) {
      if (error instanceof IdempotencyError) {
        return respond(res, { status: error.statusCode, reason: error.reason, message: error.message });
      }
      logger.error(`[idempotency] store unavailable: ${error.message}`);
      if (onStoreError === 'allow') return next();
      return respond(res, { status: 503, reason: 'unavailable', message: messages.unavailable });
    }

    if (claim.action === 'replay') {
      /* Tells the client (and its logs) that nothing was redone — the way to
         tell a replay from a double write when reading an incident. */
      setHeader(res, replayHeader, 'true');
      const stored = claim.response || { statusCode: 200, body: null };
      return res.status(stored.statusCode).json(stored.body);
    }

    captureResponse(res, (response) => {
      const settle = remember(response.statusCode) ? claim.finish(response) : claim.abort();
      return settle.catch((e) => logger.error(`[idempotency] could not settle key: ${e.message}`));
    });
    return next();
  };
}

/*
 * Record the answer BEFORE it leaves. Sending first and saving afterwards lets
 * a client that retries the instant it gets the answer find the key still "in
 * progress" and receive a 409 for a request that succeeded.
 *
 * Responses that never go through res.json (res.send, res.end, a stream) are
 * settled on 'finish' with an empty body: the work happened, and a replay must
 * not run it again, even if it cannot hand back the original body.
 */
function captureResponse(res, onResponse) {
  let captured = false;
  const originalJson = res.json;

  res.json = function idempotentJson(body) {
    if (captured) return originalJson.call(res, body);
    captured = true;
    Promise.resolve(onResponse({ statusCode: res.statusCode, body })).then(() => originalJson.call(res, body));
    return res;
  };

  if (typeof res.once === 'function') {
    res.once('finish', () => {
      if (captured) return;
      captured = true;
      onResponse({ statusCode: res.statusCode, body: null });
    });
  }
}

module.exports = {
  createIdempotency,
  createMemoryIdempotencyStore,
  idempotencyMiddleware,
  decideIdempotency,
  hashIdempotencyPayload,
  isValidIdempotencyKey,
  IdempotencyError,
  IDEMPOTENCY_TTL_MS: DEFAULT_TTL_MS
};
