/**
 * One instance runs the job; the others skip their turn.
 *
 * A clustered app (PM2 cluster mode, several containers, several pods) starts
 * the SAME scheduled jobs in every process. Clustering spreads REQUESTS; a
 * periodic job repeated in four processes is not shared, it is duplicated.
 * Seen in production: one reminder job sent four identical notifications to
 * the same person in the same second, and a nightly backup ran four database
 * dumps at once.
 *
 * In-process guards ("already sent" dates, `isProcessing` flags) cannot fix
 * that: they are local to one process, and all four read the guard BEFORE any
 * of them writes it. The lock has to live in a store every instance shares,
 * and taking it has to be a single atomic write.
 *
 * Two properties are non-negotiable:
 *   - it EXPIRES. An instance that dies while holding the lock must not block
 *     the job forever; the next tick after the hold elapses is free again.
 *   - only the OWNER can release it. An instance whose work outlived its hold
 *     must not delete the lock a newer holder just took — that reopens the
 *     door to exactly the duplicate the lock exists to prevent.
 *
 * The store is injected: Redis, MongoDB, or memory for tests and single
 * process apps.
 */

const crypto = require('crypto');
const os = require('os');

function assertHold(holdMs) {
  /* A zero or negative hold is a lock that is already expired when written:
     every instance would take it, silently. Refuse it loudly instead. */
  if (!Number.isFinite(holdMs) || holdMs <= 0) {
    throw new TypeError(`holdMs must be a positive number of milliseconds, got ${holdMs}`);
  }
}

/**
 * Default owner identity. A bare process id is NOT enough: every container
 * runs its app as pid 1, and two machines happily share pids — two owners
 * with the same name could release each other's locks.
 */
function defaultOwner() {
  return `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
}

/**
 * In-memory store. Correct for one process (and for tests); useless across a
 * cluster, by definition — which is why the store is injected.
 */
function createMemoryLockStore() {
  const locks = new Map();
  return {
    async acquire({ key, owner, holdMs, now }) {
      const current = locks.get(key);
      if (current && current.expiresAt > now) return false;
      locks.set(key, { owner, expiresAt: now + holdMs });
      return true;
    },
    async release({ key, owner }) {
      const current = locks.get(key);
      if (!current || current.owner !== owner) return false;
      locks.delete(key);
      return true;
    },
    size: () => locks.size
  };
}

/**
 * MongoDB store, on a native driver collection (or a mongoose model — same
 * `updateOne`/`deleteOne` shape).
 *
 * The filter `expiresAt <= now` is what makes the upsert atomic: only a writer
 * that finds the lock missing or expired matches; the others try to INSERT a
 * document whose `_id` already exists and hit a duplicate key error (11000),
 * which here means "someone else has it", not a failure.
 *
 * Add a TTL index on `expiresAt` (`expireAfterSeconds: 0`) so expired locks do
 * not accumulate as one row per job forever.
 */
function createMongoLockStore(collection) {
  return {
    async acquire({ key, owner, holdMs, now }) {
      try {
        await collection.updateOne(
          { _id: key, expiresAt: { $lte: new Date(now) } },
          { $set: { owner, expiresAt: new Date(now + holdMs) } },
          { upsert: true }
        );
        return true;
      } catch (error) {
        if (error && error.code === 11000) return false;
        throw error;
      }
    },
    async release({ key, owner }) {
      const result = await collection.deleteOne({ _id: key, owner });
      return Boolean(result && result.deletedCount === 1);
    }
  };
}

/* Compare-and-delete in one step. A GET then DEL from the client would leave
   a window where the lock expires, another instance takes it, and our DEL
   removes THEIR lock. */
const REDIS_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Redis store. `command(args)` sends one raw command and resolves its reply,
 * which keeps this adapter independent of the client library:
 *   node-redis: (args) => client.sendCommand(args)
 *   ioredis:    (args) => client.call(...args)
 *
 * `SET NX PX` is atomic and Redis expires the key itself, on its own clock —
 * no clock skew between instances to reason about.
 */
function createRedisLockStore({ command }) {
  return {
    async acquire({ key, owner, holdMs }) {
      const reply = await command(['SET', key, owner, 'NX', 'PX', String(Math.ceil(holdMs))]);
      return reply === 'OK';
    },
    async release({ key, owner }) {
      const reply = await command(['EVAL', REDIS_RELEASE_SCRIPT, '1', key, owner]);
      return Number(reply) === 1;
    }
  };
}

/**
 * @param {object} options
 * @param {object} options.store   { acquire({key, owner, holdMs, now}), release({key, owner}) }
 * @param {string} [options.owner] identity of this instance. Default: host + pid + random.
 * @param {string} [options.prefix] namespace for lock keys. Default 'joblock:'.
 * @param {Function} [options.now]
 */
function createJobLock(options = {}) {
  const store = options.store;
  if (!store || typeof store.acquire !== 'function' || typeof store.release !== 'function') {
    throw new TypeError('createJobLock needs a store with acquire() and release()');
  }
  const owner = options.owner || defaultOwner();
  const prefix = options.prefix === undefined ? 'joblock:' : options.prefix;
  const now = options.now || (() => Date.now());

  /**
   * May this instance run `name` now? True for ONE instance at a time.
   *
   * A store failure is thrown, not swallowed as `false`: an unreachable
   * database must not silently cancel a reminder. A duplicate is visible and
   * recoverable; a job that quietly never runs is neither.
   */
  async function claim(name, holdMs) {
    assertHold(holdMs);
    return Boolean(await store.acquire({ key: prefix + name, owner, holdMs, now: now() }));
  }

  /** Release early — only if WE still hold it. Returns whether it was ours. */
  async function release(name) {
    return Boolean(await store.release({ key: prefix + name, owner }));
  }

  /**
   * Run `fn` only if the lock is free. Resolves `null` when another instance
   * holds it.
   *
   * By default the lock is NOT released when `fn` finishes: it expires. Pick a
   * hold a little shorter than the job's interval. Releasing at the end would
   * let an instance whose timer fires a few seconds later take the freshly
   * freed lock and run the same tick again. Pass `{ release: true }` only for
   * jobs where running again right away is harmless.
   */
  async function run(name, holdMs, fn, runOptions = {}) {
    if (!(await claim(name, holdMs))) return null;
    if (!runOptions.release) return fn();
    try {
      return await fn();
    } finally {
      /* A failed early release is harmless — the lock still expires — and
         must not replace the job's own result or error. */
      await release(name).catch(() => {});
    }
  }

  return { claim, release, run, owner };
}

module.exports = { createJobLock, createMemoryLockStore, createMongoLockStore, createRedisLockStore };
