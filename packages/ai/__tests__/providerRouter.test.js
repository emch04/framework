const { createProviderRouter } = require('../src');

const provider = (id, models, call) => ({ id, models, call });

describe('providerRouter', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('selects intent-preferred model when it also supports the requested complexity', async () => {
    const calls = [];
    const router = createProviderRouter({
      intentRouting: {
        summarize: { preferred: ['preferred-medium'] }
      },
      providers: [
        provider('primary', [
          { id: 'fallback-simple', rpm: 10, rpd: 10, tpd: 1000, complexity: ['simple'] },
          { id: 'preferred-medium', rpm: 10, rpd: 10, tpd: 1000, complexity: ['medium'] }
        ], async (prompt, ctx, model) => {
          calls.push({ prompt, ctx, modelId: model.id });
          return `used:${model.id}`;
        })
      ]
    });

    await expect(router.ask('hello', {
      intent: 'summarize',
      complexity: 'medium',
      estimatedTokens: 10
    }, { tenantId: 'demo' })).resolves.toBe('used:preferred-medium');

    expect(calls).toEqual([
      { prompt: 'hello', ctx: { tenantId: 'demo' }, modelId: 'preferred-medium' }
    ]);
    router.stop();
  });

  test('falls back while a model is in cooldown after a 429 response', async () => {
    const firstError = new Error('too many requests');
    firstError.statusCode = 429;
    const primaryCall = jest.fn()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValue('primary recovered');
    const fallbackCall = jest.fn().mockResolvedValue('fallback answer');
    const router = createProviderRouter({
      cooldownMs: 60_000,
      cooldownJitterMs: 0,
      providers: [
        provider('primary', [
          { id: 'primary-model', rpm: 10, rpd: 10, tpd: 1000, complexity: ['simple'] }
        ], primaryCall),
        provider('fallback', [
          { id: 'fallback-model', rpm: 10, rpd: 10, tpd: 1000, complexity: ['simple'] }
        ], fallbackCall)
      ]
    });

    await expect(router.ask('first', { complexity: 'simple', estimatedTokens: 10 })).resolves.toBe('fallback answer');
    await expect(router.ask('second', { complexity: 'simple', estimatedTokens: 10 })).resolves.toBe('fallback answer');

    const stats = router.getStats();
    expect(stats['primary-model'].cooldown).toBe(true);
    expect(primaryCall).toHaveBeenCalledTimes(1);
    expect(fallbackCall).toHaveBeenCalledTimes(2);
    router.stop();
  });

  test('degrades a failing model after repeated provider errors', async () => {
    const primaryCall = jest.fn().mockRejectedValue(new Error('provider failed'));
    const fallbackCall = jest.fn().mockResolvedValue('fallback answer');
    const router = createProviderRouter({
      maxFailures: 2,
      degradedMs: 300_000,
      providers: [
        provider('primary', [
          { id: 'unstable-model', rpm: 10, rpd: 10, tpd: 1000, complexity: ['simple'] }
        ], primaryCall),
        provider('fallback', [
          { id: 'stable-model', rpm: 10, rpd: 10, tpd: 1000, complexity: ['simple'] }
        ], fallbackCall)
      ]
    });

    await router.ask('one', { complexity: 'simple', estimatedTokens: 10 });
    await router.ask('two', { complexity: 'simple', estimatedTokens: 10 });
    await router.ask('three', { complexity: 'simple', estimatedTokens: 10 });

    expect(router.getStats()['unstable-model']).toMatchObject({
      degraded: true,
      failures: 2
    });
    expect(primaryCall).toHaveBeenCalledTimes(2);
    expect(fallbackCall).toHaveBeenCalledTimes(3);
    router.stop();
  });

  test('resets daily request and token counters at midnight', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T21:59:50.000Z'));
    const router = createProviderRouter({
      providers: [
        provider('primary', [
          { id: 'daily-model', rpm: 10, rpd: 2, tpd: 100, complexity: ['simple'] }
        ], async () => 'answer')
      ]
    });

    await router.ask('first', { complexity: 'simple', estimatedTokens: 20 });
    expect(router.getStats()['daily-model']).toMatchObject({
      rpd_used: 1,
      tpd_used: 20
    });

    jest.advanceTimersByTime(11_000);
    await Promise.resolve();

    expect(router.getStats()['daily-model']).toMatchObject({
      rpd_used: 0,
      tpd_used: 0
    });
    router.stop();
  });

  test('works without Redis configuration', async () => {
    const router = createProviderRouter({
      providers: [
        provider('memory-only', [
          { id: 'memory-model', rpm: 10, rpd: 10, tpd: 1000, complexity: ['simple'] }
        ], async () => 'ok')
      ]
    });

    await expect(router.ask('hello', { complexity: 'simple', estimatedTokens: 1 })).resolves.toBe('ok');
    expect(router.getStats()['memory-model'].rpd_used).toBe(1);
    router.stop();
  });

  test('restores usage and cooldown state from Redis on startup', async () => {
    const fakeClient = {
      isOpen: true,
      connect: jest.fn().mockResolvedValue(),
      disconnect: jest.fn().mockResolvedValue(),
      on: jest.fn(),
      get: jest.fn((key) => {
        if (key.includes(':rpd:')) return Promise.resolve('4');
        if (key.includes(':tpd:')) return Promise.resolve('40');
        return Promise.resolve(null);
      }),
      ttl: jest.fn((key) => Promise.resolve(key.includes(':cooldown:') ? 30 : -2)),
      incrBy: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1)
    };

    jest.doMock('redis', () => ({ createClient: jest.fn(() => fakeClient) }), { virtual: true });
    jest.resetModules();
    const { createProviderRouter: createRouterWithMockedRedis } = require('../src');

    const router = createRouterWithMockedRedis({
      redisUrl: 'redis://localhost:6379',
      providers: [
        provider('primary', [
          { id: 'shared-model', rpm: 10, rpd: 10, tpd: 1000, complexity: ['simple'] }
        ], async () => 'answer')
      ]
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const stats = router.getStats();
    expect(stats['shared-model'].rpd_used).toBe(4);
    expect(stats['shared-model'].tpd_used).toBe(40);
    expect(stats['shared-model'].cooldown).toBe(true);

    router.stop();
    expect(fakeClient.disconnect).toHaveBeenCalled();
    jest.dontMock('redis');
    jest.resetModules();
  });
});
