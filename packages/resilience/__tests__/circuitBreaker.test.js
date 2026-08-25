const { createCircuitBreaker, CircuitOpenError } = require('../src');

function build(overrides = {}) {
  let time = 0;
  const changes = [];
  const breaker = createCircuitBreaker({
    name: 'ia',
    failureThreshold: 3,
    recoveryMs: 10_000,
    now: () => time,
    onStateChange: (change) => changes.push(`${change.from}->${change.to}`),
    ...overrides
  });
  return { breaker, changes, advance: (ms) => { time += ms; } };
}

const boom = () => { throw new Error('service down'); };

describe('opening', () => {
  test('passes calls through while the service answers', async () => {
    const { breaker } = build();

    expect(await breaker.call(async () => 'ok')).toBe('ok');
    expect(breaker.status().state).toBe('closed');
  });

  test('opens after the threshold of consecutive failures', async () => {
    const { breaker, changes } = build();

    for (let i = 0; i < 3; i += 1) await breaker.call(boom).catch(() => {});

    expect(breaker.isOpen()).toBe(true);
    expect(changes).toEqual(['closed->open']);
  });

  test('a success resets the count — only CONSECUTIVE failures open it', async () => {
    const { breaker } = build();

    await breaker.call(boom).catch(() => {});
    await breaker.call(boom).catch(() => {});
    await breaker.call(async () => 'ok');
    await breaker.call(boom).catch(() => {});
    await breaker.call(boom).catch(() => {});

    expect(breaker.isOpen()).toBe(false);
  });

  test('open means an IMMEDIATE refusal — the slow failure becomes a fast one', async () => {
    const { breaker } = build();
    for (let i = 0; i < 3; i += 1) await breaker.call(boom).catch(() => {});

    let reached = false;
    const error = await breaker.call(async () => { reached = true; }).catch((e) => e);

    expect(reached).toBe(false);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(error.code).toBe('CIRCUIT_OPEN');
    expect(error.retryInMs).toBeGreaterThan(0);
  });

  test('a business error does not open the breaker when isFailure says so', async () => {
    /* A 404 is an answer, not an outage. */
    const { breaker } = build({ isFailure: (e) => !e.statusCode || e.statusCode >= 500 });
    const notFound = () => { const e = new Error('introuvable'); e.statusCode = 404; throw e; };

    for (let i = 0; i < 10; i += 1) await breaker.call(notFound).catch(() => {});

    expect(breaker.isOpen()).toBe(false);
  });
});

describe('recovery', () => {
  const opened = async () => {
    const built = build();
    for (let i = 0; i < 3; i += 1) await built.breaker.call(boom).catch(() => {});
    return built;
  };

  test('after the delay, ONE probe goes through', async () => {
    const { breaker, advance } = await opened();
    advance(10_001);

    expect(await breaker.call(async () => 'rétabli')).toBe('rétabli');
    expect(breaker.status().state).toBe('closed');
  });

  test('while the probe is in flight, everyone else is still refused', async () => {
    /* Letting every queued caller through "to test" is the thundering herd
       the breaker exists to prevent — delivered on schedule. */
    const { breaker, advance } = await opened();
    advance(10_001);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const probe = breaker.call(() => gate);

    const second = await breaker.call(async () => 'moi aussi').catch((e) => e);
    expect(second).toBeInstanceOf(CircuitOpenError);

    release('rétabli');
    expect(await probe).toBe('rétabli');
    expect(await breaker.call(async () => 'ok')).toBe('ok');
  });

  test('a failed probe re-opens IMMEDIATELY — one bad answer is proof enough', async () => {
    const { breaker, advance, changes } = await opened();
    advance(10_001);

    await breaker.call(boom).catch(() => {});

    expect(breaker.isOpen()).toBe(true);
    expect(changes).toEqual(['closed->open', 'open->half-open', 'half-open->open']);

    /* And the delay restarts from the failed probe, not the first opening. */
    advance(9_000);
    await expect(breaker.call(async () => 'x')).rejects.toBeInstanceOf(CircuitOpenError);
    advance(1_001);
    expect(await breaker.call(async () => 'x')).toBe('x');
  });

  test('a business error during the probe closes the circuit — the service answered', async () => {
    const { breaker, advance } = await (async () => {
      const built = build({ isFailure: (e) => !e.statusCode || e.statusCode >= 500 });
      for (let i = 0; i < 3; i += 1) await built.breaker.call(boom).catch(() => {});
      return built;
    })();
    advance(10_001);
    const notFound = () => { const e = new Error('introuvable'); e.statusCode = 404; throw e; };

    await breaker.call(notFound).catch(() => {});

    expect(breaker.status().state).toBe('closed');
  });

  test('reset() closes the door without waiting out the delay', async () => {
    const { breaker } = await opened();

    breaker.reset();

    expect(breaker.status()).toMatchObject({ state: 'closed', failures: 0 });
    expect(await breaker.call(async () => 'ok')).toBe('ok');
  });
});

describe('ergonomics', () => {
  test('wrap() puts a function permanently behind the breaker', async () => {
    const { breaker } = build();
    const guarded = breaker.wrap(async (a, b) => a + b);

    expect(await guarded(2, 3)).toBe(5);
  });

  test('the original error reaches the caller — the breaker observes, it does not rewrite', async () => {
    const { breaker } = build();

    await expect(breaker.call(boom)).rejects.toThrow('service down');
  });

  test('status() names the circuit for dashboards', async () => {
    const { breaker } = build();

    expect(breaker.status()).toEqual({ name: 'ia', state: 'closed', failures: 0, openedAt: null });
  });
});
