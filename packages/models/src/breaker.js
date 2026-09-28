/**
 * The breaker used per endpoint when none is injected.
 *
 * Same shape as `createCircuitBreaker` of @astratra/resilience —
 * `{ call(fn), isOpen(), status(), reset() }`, refusals thrown with
 * `code: 'CIRCUIT_OPEN'` — so either can be plugged in. Defaults follow the
 * model service: 3 consecutive failures open it for 60 s, then ONE probe goes
 * through; a failed probe re-opens at once.
 *
 * One difference, on purpose: `isOpen()` turns false as soon as the recovery
 * delay has elapsed (a probe would be let through), so `available()` answers
 * "may I call now?" rather than "what state is stored?".
 */

class ModelsCircuitOpenError extends Error {
  constructor(name, retryInMs) {
    super(`Circuit "${name}" is open.`);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.retryInMs = Math.max(0, retryInMs);
  }
}

function createEndpointBreaker(options = {}) {
  const name = options.name || 'models';
  const failureThreshold = options.failureThreshold || 3;
  const recoveryMs = options.recoveryMs === undefined ? 60_000 : options.recoveryMs;
  const now = options.now || (() => Date.now());
  const onStateChange = options.onStateChange || (() => {});

  let state = 'closed';
  let failures = 0;
  let openedAt = 0;
  let probing = false;

  function transition(to) {
    if (state === to) return;
    const from = state;
    state = to;
    try { onStateChange({ name, from, to }); } catch (_error) { /* an observer never breaks a call */ }
  }

  function open() {
    openedAt = now();
    probing = false;
    transition('open');
  }

  async function call(fn) {
    if (state === 'open') {
      const elapsed = now() - openedAt;
      if (elapsed < recoveryMs) throw new ModelsCircuitOpenError(name, recoveryMs - elapsed);
      transition('half-open');
    }
    if (state === 'half-open') {
      if (probing) throw new ModelsCircuitOpenError(name, recoveryMs);
      probing = true;
    }
    try {
      const result = await fn();
      failures = 0;
      probing = false;
      transition('closed');
      return result;
    } catch (error) {
      if (state === 'half-open') {
        open();
      } else {
        failures += 1;
        if (failures >= failureThreshold) open();
      }
      throw error;
    }
  }

  return {
    call,
    isOpen: () => (state === 'open' && now() - openedAt < recoveryMs) || (state === 'half-open' && probing),
    status: () => ({ name, state, failures, openedAt: state === 'open' ? openedAt : null }),
    reset: () => { failures = 0; probing = false; transition('closed'); }
  };
}

module.exports = { createEndpointBreaker, ModelsCircuitOpenError };
