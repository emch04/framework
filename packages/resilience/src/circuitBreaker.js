/**
 * Stop calling what keeps failing.
 *
 * A dependency that is down does not just fail — it fails SLOWLY. Every call
 * waits out its timeout, requests pile up behind it, and a dead third-party
 * API takes your own service down with it. The breaker replaces that slow
 * failure with a fast one: after enough consecutive errors it OPENS, and
 * callers get an immediate refusal instead of a hanging socket.
 *
 *   CLOSED    normal — calls pass, failures are counted;
 *   OPEN      refusing — calls fail instantly, until the recovery delay;
 *   HALF_OPEN probing — ONE call is let through to test the water.
 *
 * The half-open probe is singular on purpose. Letting every queued caller
 * through "to test" means the moment the delay expires, a thundering herd hits
 * a service that is probably still on its knees — and the pile-up you built
 * the breaker to prevent happens anyway, on schedule.
 */

const CLOSED = 'closed';
const OPEN = 'open';
const HALF_OPEN = 'half-open';

class CircuitOpenError extends Error {
  constructor(name, retryInMs) {
    super(`Circuit "${name}" is open — retry in ${Math.max(0, Math.ceil(retryInMs / 1000))}s.`);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.retryInMs = Math.max(0, retryInMs);
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.name]
 * @param {number} [options.failureThreshold] consecutive failures before opening. Default 5.
 * @param {number} [options.recoveryMs]       how long to refuse before probing. Default 30s.
 * @param {Function} [options.isFailure]      (error) => boolean. A 404 is an
 *   answer, not an outage: counting business errors as failures opens the
 *   breaker on a healthy service. Default: everything thrown counts.
 * @param {Function} [options.onStateChange]  ({ name, from, to, error? }) => void.
 * @param {Function} [options.now]
 */
function createCircuitBreaker(options = {}) {
  const name = options.name || 'circuit';
  const failureThreshold = options.failureThreshold || 5;
  const recoveryMs = options.recoveryMs === undefined ? 30_000 : options.recoveryMs;
  const isFailure = options.isFailure || (() => true);
  const onStateChange = options.onStateChange || (() => {});
  const now = options.now || (() => Date.now());

  let state = CLOSED;
  let failures = 0;
  let openedAt = 0;
  let probing = false;

  function transition(to, error) {
    if (state === to) return;
    const from = state;
    state = to;
    onStateChange({ name, from, to, error: error || null });
  }

  function recordSuccess() {
    failures = 0;
    probing = false;
    transition(CLOSED);
  }

  function recordFailure(error) {
    /* A failed probe re-opens immediately: one bad answer is enough proof the
       service is still down, no need to count to the threshold again. */
    if (state === HALF_OPEN) {
      probing = false;
      openedAt = now();
      transition(OPEN, error);
      return;
    }
    failures += 1;
    if (failures >= failureThreshold) {
      openedAt = now();
      transition(OPEN, error);
    }
  }

  /** Run `fn` under the breaker. */
  async function call(fn) {
    if (state === OPEN) {
      const elapsed = now() - openedAt;
      if (elapsed < recoveryMs) throw new CircuitOpenError(name, recoveryMs - elapsed);
      transition(HALF_OPEN);
    }

    if (state === HALF_OPEN) {
      /* One probe. Everybody else keeps getting the fast refusal until the
         probe reports back. */
      if (probing) throw new CircuitOpenError(name, recoveryMs);
      probing = true;
    }

    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (error) {
      if (isFailure(error)) recordFailure(error);
      else if (state === HALF_OPEN) recordSuccess();
      throw error;
    }
  }

  /** Wrap a function so every invocation goes through the breaker. */
  const wrap = (fn) => (...args) => call(() => fn(...args));

  return {
    call,
    wrap,
    status: () => ({ name, state, failures, openedAt: state === OPEN ? openedAt : null }),
    isOpen: () => state === OPEN,
    /* For operators: force the door shut again after a fix is deployed,
       without waiting out the delay. */
    reset: () => { failures = 0; probing = false; transition(CLOSED); }
  };
}

module.exports = { createCircuitBreaker, CircuitOpenError, CLOSED, OPEN, HALF_OPEN };
