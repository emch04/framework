const { createCircuitBreaker } = require('@astratra/resilience');
const { createBreakerPool, createProviderRouter: createRouter, isCircuitOpen, isProviderOutage } = require('../src');

/* Every router is stopped even when an assertion fails first: its midnight
   timer would otherwise keep the test run alive. */
const openRouters = [];
const createProviderRouter = (config) => {
  const router = createRouter(config);
  openRouters.push(router);
  return router;
};
afterEach(() => { openRouters.splice(0).forEach((router) => router.stop()); });


const model = (id) => ({ id, rpm: 100, rpd: 1000, tpd: 1_000_000, complexity: ['simple'] });
const down = () => Object.assign(new Error('503 upstream'), { statusCode: 503 });

function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

describe('isProviderOutage', () => {
  test.each([
    [{ statusCode: 503 }, true],
    [{ status: 500 }, true],
    [{ statusCode: 408 }, true],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), true],
    [{ statusCode: 429 }, false],
    [{ code: 429 }, false],
    [{ statusCode: 401 }, false],
    [{ statusCode: 400 }, false],
    [null, false]
  ])('%o is an outage: %s', (error, expected) => {
    expect(isProviderOutage(error)).toBe(expected);
  });
});

describe('createBreakerPool', () => {
  test('one breaker per key, created once', () => {
    const created = [];
    const pool = createBreakerPool({ create: (key) => { created.push(key); return createCircuitBreaker({ name: key }); } });
    expect(pool.get('groq')).toBe(pool.get('groq'));
    pool.get('mistral');
    expect(created).toEqual(['groq', 'mistral']);
    expect(pool.keys()).toEqual(['groq', 'mistral']);
  });

  test('a factory that hands back the SAME breaker for two keys is refused — that is the shared circuit', () => {
    const shared = createCircuitBreaker({ name: 'everything' });
    const pool = createBreakerPool({ create: () => shared });
    pool.get('reranker');
    expect(() => pool.get('entities')).toThrow(/one breaker per key/);
  });

  test('a failing key opens only its own circuit', async () => {
    const pool = createBreakerPool({ create: (key) => createCircuitBreaker({ name: key, failureThreshold: 3, recoveryMs: 60_000 }) });
    for (let i = 0; i < 3; i += 1) await pool.run('/rerank', async () => { throw down(); }).catch(() => {});
    expect(pool.stateOf('/rerank')).toBe('open');
    await expect(pool.run('/entities', async () => ['Kevin'])).resolves.toEqual(['Kevin']);
    expect(pool.stateOf('/entities')).toBe('closed');
    const refused = await pool.run('/rerank', async () => 'never').catch((e) => e);
    expect(isCircuitOpen(refused)).toBe(true);
  });

  test('status and reset reach every breaker; a factory without call() is refused', async () => {
    const pool = createBreakerPool({ create: (key) => createCircuitBreaker({ name: key, failureThreshold: 1 }) });
    await pool.run('a', async () => { throw down(); }).catch(() => {});
    expect(pool.status().a.state).toBe('open');
    pool.reset();
    expect(pool.stateOf('a')).toBe('closed');
    expect(pool.stateOf('never-used')).toBeNull();
    expect(() => createBreakerPool({ create: () => ({}) }).get('x')).toThrow(/call/);
    expect(() => createBreakerPool({})).toThrow(/create/);
  });
});

describe('provider router with one circuit per provider', () => {
  function build({ failureThreshold = 2, recoveryMs = 30_000, breakers } = {}) {
    const time = clock();
    const primary = jest.fn(async () => { throw down(); });
    const secondary = jest.fn(async (prompt) => `secondary:${prompt}`);
    const router = createProviderRouter({
      maxFailures: 99,
      breakers: breakers || ((id) => createCircuitBreaker({ name: id, failureThreshold, recoveryMs, now: time.now, isFailure: isProviderOutage })),
      providers: [
        { id: 'primary', models: [model('p1'), model('p2')], call: primary },
        { id: 'secondary', models: [model('s1')], call: secondary }
      ]
    });
    return { router, primary, secondary, time };
  }

  test('a provider that keeps failing is skipped without being called, the others keep answering', async () => {
    const { router, primary, secondary } = build();
    await expect(router.ask('one', { complexity: 'simple' })).resolves.toBe('secondary:one');
    expect(primary).toHaveBeenCalledTimes(2);
    await expect(router.ask('two', { complexity: 'simple' })).resolves.toBe('secondary:two');
    expect(primary).toHaveBeenCalledTimes(2);
    expect(secondary).toHaveBeenCalledTimes(2);
    const stats = router.getStats();
    expect(stats['primary:p1'].circuit).toBe('open');
    expect(stats['secondary:s1'].circuit).toBe('closed');
    router.stop();
  });

  test('one provider opening its circuit never opens another\'s', async () => {
    const { router, secondary } = build({ failureThreshold: 1 });
    for (let i = 0; i < 5; i += 1) await router.ask(`q${i}`, { complexity: 'simple' });
    expect(secondary).toHaveBeenCalledTimes(5);
    expect(router.breakers.stateOf('secondary')).toBe('closed');
    router.stop();
  });

  test('a call the breaker refused costs no quota and does not count as a model failure', async () => {
    const { router } = build();
    await router.ask('one', { complexity: 'simple', estimatedTokens: 50 });
    const before = router.getStats()['primary:p1'];
    await router.ask('two', { complexity: 'simple', estimatedTokens: 50 });
    const after = router.getStats()['primary:p1'];
    expect(after.rpd_used).toBe(before.rpd_used);
    expect(after.tpd_used).toBe(before.tpd_used);
    expect(after.failures).toBe(before.failures);
    router.stop();
  });

  test('after the recovery delay ONE probe goes through, and a healthy provider is back', async () => {
    const { router, primary, time } = build({ recoveryMs: 30_000 });
    await router.ask('one', { complexity: 'simple' });
    primary.mockImplementation(async (prompt) => `primary:${prompt}`);
    time.advance(31_000);
    await expect(router.ask('back', { complexity: 'simple' })).resolves.toBe('primary:back');
    expect(router.breakers.stateOf('primary')).toBe('closed');
    router.stop();
  });

  test('a 429 does not open the circuit: the cooldown handles it', async () => {
    const limited = jest.fn(async () => { throw Object.assign(new Error('slow down'), { statusCode: 429 }); });
    const router = createProviderRouter({
      cooldownJitterMs: 0,
      breakers: (id) => createCircuitBreaker({ name: id, failureThreshold: 1, isFailure: isProviderOutage }),
      providers: [
        { id: 'limited', models: [model('l1')], call: limited },
        { id: 'other', models: [model('o1')], call: async () => 'other' }
      ]
    });
    await router.ask('x', { complexity: 'simple' });
    expect(router.breakers.stateOf('limited')).toBe('closed');
    expect(router.getStats()['limited:l1'].cooldown).toBe(true);
    router.stop();
  });

  test('a pool can be passed directly, and a wrong value is refused', () => {
    const pool = createBreakerPool({ create: (id) => createCircuitBreaker({ name: id }) });
    const router = createProviderRouter({ breakers: pool, providers: [] });
    expect(router.breakers).toBe(pool);
    router.stop();
    expect(() => createProviderRouter({ breakers: { nope: true } })).toThrow(/breakers/);
  });

  test('without breakers the router behaves as before and reports no circuit', async () => {
    const router = createProviderRouter({ providers: [{ id: 'only', models: [model('m')], call: async () => 'ok' }] });
    await router.ask('x', { complexity: 'simple' });
    expect(router.getStats()['only:m'].circuit).toBeNull();
    expect(router.breakers).toBeNull();
    router.stop();
  });
});
