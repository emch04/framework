/**
 * One circuit per provider — never one for all.
 *
 * A single breaker shared by every outside dependency looks tidy and is a
 * trap: a slow reranker opened it, and the name detector behind the privacy
 * mask went dark with it for a full minute. The failing thing must be the only
 * thing that stops.
 *
 * This package ships no breaker of its own. `@astratra/resilience` has one,
 * with a single half-open probe; inject its factory:
 *
 *   const { createCircuitBreaker } = require('@astratra/resilience');
 *   const breakers = createBreakerPool({
 *     create: (id) => createCircuitBreaker({ name: id, isFailure: isProviderOutage })
 *   });
 *
 * Any object with `call(fn)` fits; `status()` and `reset()` are used when
 * present.
 */

/**
 * Is this error the provider being DOWN, rather than refusing this request?
 *
 * A 429 is the provider saying "slow down" — the router's cooldown handles it.
 * A 400, 401, 403 or 404 is about the request or the key: opening the circuit
 * on it would take a healthy provider away from every other request. Timeouts,
 * network failures and 5xx are outages.
 */
function isProviderOutage(error) {
  if (!error) return false;
  const status = [error.statusCode, error.status, Number(error.code)].find((value) => Number.isInteger(value) && value >= 100 && value < 600);
  if (status === undefined) return true;
  if (status === 408) return true;
  return status >= 500;
}

/**
 * @param {object} options
 * @param {Function} options.create  (key) => breaker. Called once per key.
 */
function createBreakerPool(options = {}) {
  const create = options.create;
  if (typeof create !== 'function') {
    throw new Error('createBreakerPool requires options.create: (key) => breaker.');
  }
  const pool = new Map();
  const owners = new Map();

  function get(key) {
    const name = String(key);
    if (pool.has(name)) return pool.get(name);
    const breaker = create(name);
    if (!breaker || typeof breaker.call !== 'function') {
      throw new Error(`createBreakerPool: create("${name}") must return an object with call(fn).`);
    }
    /* The mistake this module exists to prevent: a factory that hands back the
       same breaker for every key re-creates the shared circuit. */
    if (owners.has(breaker)) {
      throw new Error(`createBreakerPool: "${name}" received the breaker of "${owners.get(breaker)}" — one breaker per key.`);
    }
    owners.set(breaker, name);
    pool.set(name, breaker);
    return breaker;
  }

  /** Run `fn` under the breaker of `key`. */
  const run = (key, fn) => get(key).call(fn);

  function status() {
    const out = {};
    for (const [name, breaker] of pool) {
      out[name] = typeof breaker.status === 'function' ? breaker.status() : { name };
    }
    return out;
  }

  function stateOf(key) {
    const breaker = pool.get(String(key));
    if (!breaker || typeof breaker.status !== 'function') return null;
    const current = breaker.status();
    return current && current.state ? current.state : null;
  }

  function reset(key) {
    const targets = key === undefined ? [...pool.values()] : [pool.get(String(key))].filter(Boolean);
    for (const breaker of targets) if (typeof breaker.reset === 'function') breaker.reset();
  }

  return { get, run, status, stateOf, reset, keys: () => [...pool.keys()] };
}

/** An error thrown by a breaker that refused to call — not a provider failure. */
function isCircuitOpen(error) {
  return Boolean(error && (error.code === 'CIRCUIT_OPEN' || error.name === 'CircuitOpenError'));
}

module.exports = { createBreakerPool, isProviderOutage, isCircuitOpen };
