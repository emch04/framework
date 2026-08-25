/**
 * Trying again, without making the outage worse.
 *
 * Two rules carry all the value:
 *
 *   BACKOFF WITH JITTER. Retrying immediately hammers a service that is
 *   already struggling; retrying on a fixed schedule synchronises every
 *   client into waves that all arrive together. A growing delay with a random
 *   component spreads the load out.
 *
 *   ONLY RETRY WHAT CAN CHANGE. A timeout may succeed next time; a 400 will
 *   not — the request is wrong, and sending it thrice makes it no righter. And
 *   anything non-idempotent (a payment, a send) must not be retried blindly at
 *   all: the first attempt may have succeeded without you hearing back.
 */

/**
 * @param {Function} fn  the attempt.
 * @param {object} [options]
 * @param {number} [options.attempts]    total tries, first included. Default 3.
 * @param {number} [options.baseDelayMs] first backoff. Default 200.
 * @param {number} [options.maxDelayMs]  backoff ceiling. Default 5000.
 * @param {Function} [options.shouldRetry] (error, attempt) => boolean.
 *   DEFAULTS TO NEVER for anything carrying an HTTP status < 500 — a client
 *   error does not improve with repetition.
 * @param {Function} [options.onRetry]   (error, attempt, delayMs) => void.
 * @param {Function} [options.sleep]     injected for tests.
 * @param {Function} [options.random]    injected for tests.
 */
async function retry(fn, options = {}) {
  const attempts = options.attempts || 3;
  const baseDelayMs = options.baseDelayMs === undefined ? 200 : options.baseDelayMs;
  const maxDelayMs = options.maxDelayMs === undefined ? 5000 : options.maxDelayMs;
  const shouldRetry = options.shouldRetry || defaultShouldRetry;
  const onRetry = options.onRetry || (() => {});
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random || Math.random;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) throw error;

      /* Exponential, capped, with full jitter: anywhere between 0 and the
         computed ceiling. Full jitter beats "delay ± 10%" at desynchronising
         clients, which is the whole point. */
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.round(random() * ceiling);
      onRetry(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function defaultShouldRetry(error) {
  const status = error && (error.statusCode || error.status);
  if (typeof status === 'number' && status < 500) return false;
  return true;
}

module.exports = { retry, defaultShouldRetry };
