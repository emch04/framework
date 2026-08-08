const rateLimit = require('express-rate-limit');

jest.mock('express-rate-limit', () => jest.fn((options) => options));

const { createAccountLimiter, createApiLimiter, createLoginLimiter } = require('../src');

const createRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('rateLimiters', () => {
  beforeEach(() => {
    rateLimit.mockClear();
  });

  test('createApiLimiter builds a localhost-skipping limiter with defaults', () => {
    const limiter = createApiLimiter();

    expect(rateLimit).toHaveBeenCalledWith(expect.objectContaining({
      windowMs: 15 * 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      validate: { ip: false }
    }));
    expect(limiter.skip({ ip: '127.0.0.1' })).toBe(true);
    expect(limiter.skip({ ip: '203.0.113.10' })).toBe(false);
    expect(limiter.store).toBeUndefined();
  });

  test('createApiLimiter uses an explicitly provided store before Redis configuration', () => {
    const store = { increment: jest.fn() };
    const limiter = createApiLimiter({ redisUrl: 'redis://localhost:6379', store });

    expect(limiter.store).toBe(store);
  });

  test('createLoginLimiter calls onBlocked and returns configured response', async () => {
    const onBlocked = jest.fn();
    const limiter = createLoginLimiter({ onBlocked, message: { error: 'blocked' } });
    const req = { ip: '203.0.113.10' };
    const res = createRes();

    await limiter.handler(req, res, jest.fn(), { statusCode: 429, message: limiter.message });

    expect(onBlocked).toHaveBeenCalledWith({ ip: '203.0.113.10', req });
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: 'blocked' });
  });

  test('createAccountLimiter keys by normalized identifier and reports blocked context', async () => {
    const onBlocked = jest.fn();
    const limiter = createAccountLimiter({ onBlocked });
    const req = { ip: '203.0.113.11', body: { email: 'USER@Example.COM' } };
    const res = createRes();

    expect(limiter.keyGenerator(req)).toBe('user@example.com');

    await limiter.handler(req, res, jest.fn(), { statusCode: 429, message: limiter.message });

    expect(onBlocked).toHaveBeenCalledWith({ identifier: 'USER@Example.COM', ip: '203.0.113.11', req });
    expect(res.status).toHaveBeenCalledWith(429);
  });

  describe('Redis store integration', () => {
    const loadWithRedisMocks = ({ connect, redisStoreIncrement = jest.fn() }) => {
      jest.resetModules();

      const rateLimitMock = jest.fn((options) => options);
      const memoryStoreIncrement = jest.fn(async () => ({ totalHits: 1, resetTime: new Date('2026-08-08T00:00:00.000Z') }));
      rateLimitMock.MemoryStore = jest.fn(function MemoryStore() {
        this.increment = memoryStoreIncrement;
        this.init = jest.fn();
      });

      const fakeClient = {
        connect,
        on: jest.fn(),
        sendCommand: jest.fn()
      };
      const redisStore = {
        increment: redisStoreIncrement,
        init: jest.fn()
      };
      const RedisStore = jest.fn(() => redisStore);

      jest.doMock('express-rate-limit', () => rateLimitMock);
      jest.doMock('redis', () => ({ createClient: jest.fn(() => fakeClient) }), { virtual: true });
      jest.doMock('rate-limit-redis', () => ({ RedisStore }), { virtual: true });

      const { createApiLimiter: createApiLimiterWithMocks } = require('../src');
      return {
        createApiLimiter: createApiLimiterWithMocks,
        fakeClient,
        memoryStoreIncrement,
        rateLimitMock,
        RedisStore,
        redisStore
      };
    };

    afterEach(() => {
      jest.dontMock('express-rate-limit');
      jest.dontMock('redis');
      jest.dontMock('rate-limit-redis');
      jest.resetModules();
    });

    test('createApiLimiter delegates to Redis store when Redis connects', async () => {
      const redisStoreIncrement = jest.fn(async () => ({ totalHits: 2, resetTime: new Date('2026-08-08T00:00:00.000Z') }));
      const { createApiLimiter: createLimiter, fakeClient, RedisStore } = loadWithRedisMocks({
        connect: jest.fn().mockResolvedValue(),
        redisStoreIncrement
      });

      const limiter = createLimiter({ redisUrl: 'redis://localhost:6379' });
      await new Promise((resolve) => setImmediate(resolve));
      await limiter.store.increment('api:key');

      expect(fakeClient.connect).toHaveBeenCalled();
      expect(RedisStore).toHaveBeenCalled();
      expect(redisStoreIncrement).toHaveBeenCalledWith('api:key');
    });

    test('createApiLimiter falls back to memory store when Redis connect rejects', async () => {
      const { createApiLimiter: createLimiter, memoryStoreIncrement, redisStore } = loadWithRedisMocks({
        connect: jest.fn().mockRejectedValue(new Error('redis unavailable'))
      });

      const limiter = createLimiter({ redisUrl: 'redis://localhost:6379' });
      await new Promise((resolve) => setImmediate(resolve));
      await limiter.store.increment('api:key');

      expect(redisStore.increment).not.toHaveBeenCalled();
      expect(memoryStoreIncrement).toHaveBeenCalledWith('api:key');
    });
  });
});
