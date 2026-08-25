/**
 * A TTL cache that degrades instead of failing.
 *
 * The point of a cache is that its absence is survivable. So nothing here ever
 * throws at the caller: a broken store reads as a miss, a failed write is
 * logged and dropped. The moment a cache can take a request down with it, it
 * has become a dependency — the opposite of its job.
 *
 * The store is injected (get/set/delete on serialised strings), so the same
 * code runs on Redis in production and in memory everywhere else.
 */

const NOOP_LOGGER = { warn() {} };

/** In-process store with a size cap — a cache that only grows is a slow leak. */
function createMemoryCacheStore(options = {}) {
  const maxEntries = options.maxEntries || 500;
  const entries = new Map();
  const now = options.now || (() => Date.now());

  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expireAt <= now()) { entries.delete(key); return null; }
      /* Refresh recency: Map iterates in insertion order, so re-inserting
         makes eviction drop the LEAST recently used, not the oldest write. */
      entries.delete(key);
      entries.set(key, entry);
      return entry.data;
    },
    async set(key, data, ttlSeconds) {
      entries.delete(key);
      entries.set(key, { data, expireAt: now() + ttlSeconds * 1000 });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    async delete(key) { entries.delete(key); },
    size: () => entries.size
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.store]      defaults to an in-memory store.
 * @param {number} [options.ttlSeconds] default lifetime. Default 300.
 * @param {string} [options.prefix]     namespaces the keys, so two caches can
 *   share one Redis without colliding.
 * @param {object} [options.logger]
 */
function createCache(options = {}) {
  const store = options.store || createMemoryCacheStore(options);
  const defaultTtl = options.ttlSeconds || 300;
  const prefix = options.prefix ? `${options.prefix}:` : '';
  const logger = options.logger || NOOP_LOGGER;

  const keyOf = (key) => `${prefix}${key}`;

  async function get(key) {
    try {
      const raw = await store.get(keyOf(key));
      return raw === null || raw === undefined ? null : JSON.parse(raw);
    } catch (error) {
      /* A broken cache is a MISS, never an error. */
      logger.warn(`[cache] read failed for "${key}": ${error.message}`);
      return null;
    }
  }

  async function set(key, value, ttlSeconds = defaultTtl) {
    try {
      await store.set(keyOf(key), JSON.stringify(value), ttlSeconds);
    } catch (error) {
      logger.warn(`[cache] write failed for "${key}": ${error.message}`);
    }
  }

  async function invalidate(key) {
    try {
      await store.delete(keyOf(key));
    } catch (error) {
      logger.warn(`[cache] delete failed for "${key}": ${error.message}`);
    }
  }

  /**
   * The cache-aside idiom, done once.
   *
   * On a miss, ONE computation runs per key even under concurrency: parallel
   * callers await the same in-flight promise instead of stampeding the
   * database with identical queries — which is exactly what happens the
   * second a popular entry expires.
   */
  const inFlight = new Map();

  async function remember(key, produce, ttlSeconds = defaultTtl) {
    const cached = await get(key);
    if (cached !== null) return cached;

    const pending = inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const value = await produce();
        /* null/undefined are not cached: "nothing" today should not shadow
           "something" for the next five minutes. */
        if (value !== null && value !== undefined) await set(key, value, ttlSeconds);
        return value;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, promise);
    return promise;
  }

  return { get, set, invalidate, remember };
}

module.exports = { createCache, createMemoryCacheStore };
