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
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    rateLimit.mockClear();
    process.env.NODE_ENV = originalNodeEnv;
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('createApiLimiter skips localhost by default only outside production', () => {
    process.env.NODE_ENV = 'development';
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

    rateLimit.mockClear();
    process.env.NODE_ENV = 'production';
    const productionLimiter = createApiLimiter();

    expect(productionLimiter.skip).toBeUndefined();
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

  // Régression : monté avant express.json(), req.body vaut undefined et
  // toutes les tentatives de connexion retombaient sur la clé partagée
  // "unknown" — plus de limite par compte, une seule limite globale pour
  // tous les comptes. Trouvé en auditant createWafMiddleware() (même défaut
  // exact, voir waf.js) : aucun test existant sur ce fichier n'exerçait un
  // req.body non défini.
  describe('createAccountLimiter avec req.body non parsé (mauvais ordre des middlewares)', () => {
    test('retombe sur la clé "unknown" au lieu de planter, mais avertit', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.NODE_ENV = 'development'; // le logger est un no-op en 'test'

      const limiter = createAccountLimiter({});
      const req = { ip: '203.0.113.12', body: undefined };

      expect(limiter.keyGenerator(req)).toBe('unknown');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/express\.json|unknown/i);

      warnSpy.mockRestore();
    });

    test('un keyGenerator personnalisé contourne complètement ce défaut', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.NODE_ENV = 'development';

      const customKeyGenerator = jest.fn(() => 'clé-personnalisée');
      const limiter = createAccountLimiter({ keyGenerator: customKeyGenerator });
      const req = { ip: '203.0.113.13', body: undefined };

      expect(limiter.keyGenerator(req)).toBe('clé-personnalisée');
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
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

      const {
        createApiLimiter: createApiLimiterWithMocks,
        createRedisRateLimitStore: createRedisRateLimitStoreWithMocks
      } = require('../src');
      return {
        createApiLimiter: createApiLimiterWithMocks,
        createRedisRateLimitStore: createRedisRateLimitStoreWithMocks,
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

    test('createRedisRateLimitStore transmet le préfixe défini par le projet', async () => {
      const { createRedisRateLimitStore: createStore, RedisStore } = loadWithRedisMocks({
        connect: jest.fn().mockResolvedValue()
      });

      createStore({ redisUrl: 'redis://localhost:6379', prefix: 'application:rate:admin:' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(RedisStore).toHaveBeenCalledWith(expect.objectContaining({
        prefix: 'application:rate:admin:'
      }));
    });

    /*
     * Le vrai RedisStore emet son script d'increment DEPUIS SON CONSTRUCTEUR,
     * et le vrai client redis rejette tant qu'il n'est pas connecte. Le mock
     * ci-dessus ne fait ni l'un ni l'autre : c'est pourquoi ce defaut a vecu
     * dans le paquet sans qu'aucun test ne le voie.
     *
     * Celui-ci reproduit les deux comportements. Sans le correctif, l'appel du
     * constructeur produit un rejet que personne ne possede — et Node tue le
     * processus au demarrage, meme quand Redis fonctionne parfaitement.
     */
    const loadWithRealisticRedisMocks = ({ connect }) => {
      jest.resetModules();

      const rateLimitMock = jest.fn((options) => options);
      rateLimitMock.MemoryStore = jest.fn(function MemoryStore() {
        this.increment = jest.fn(async () => ({ totalHits: 1, resetTime: new Date('2026-08-08T00:00:00.000Z') }));
        this.init = jest.fn();
      });

      let connected = false;
      const fakeClient = {
        connect: jest.fn(async () => {
          await connect();
          connected = true;
        }),
        on: jest.fn(),
        isOpen: false,
        disconnect: jest.fn(async () => {}),
        sendCommand: jest.fn(async () => {
          if (!connected) {
            const error = new Error('The client is closed');
            error.name = 'ClientClosedError';
            throw error;
          }
          return 'sha1-of-increment-script';
        })
      };

      // Ce que fait rate-limit-redis : charger son script dans le constructeur,
      // sans attendre la promesse retournee.
      const scriptLoads = [];
      const RedisStore = jest.fn(function RedisStore(options) {
        scriptLoads.push(options.sendCommand('SCRIPT', 'LOAD', 'return 1'));
        this.increment = jest.fn();
        this.init = jest.fn();
      });

      jest.doMock('express-rate-limit', () => rateLimitMock);
      jest.doMock('redis', () => ({ createClient: jest.fn(() => fakeClient) }), { virtual: true });
      jest.doMock('rate-limit-redis', () => ({ RedisStore }), { virtual: true });

      const { createRedisRateLimitStore: createStore } = require('../src');
      return { createStore, fakeClient, scriptLoads };
    };

    test('la commande emise par le constructeur du store attend la connexion au lieu de rejeter', async () => {
      const { createStore, scriptLoads } = loadWithRealisticRedisMocks({
        connect: jest.fn().mockResolvedValue()
      });

      createStore({ redisUrl: 'redis://localhost:6379', prefix: 'application:rate:api:' });

      expect(scriptLoads).toHaveLength(1);
      await expect(scriptLoads[0]).resolves.toBe('sha1-of-increment-script');
    });

    test('un Redis injoignable ne laisse pas non plus de rejet sans proprietaire', async () => {
      const { createStore, scriptLoads } = loadWithRealisticRedisMocks({
        connect: jest.fn().mockRejectedValue(new Error('redis unavailable'))
      });

      createStore({ redisUrl: 'redis://localhost:6379' });

      // Le store Redis ne sera jamais choisi par le failover : sa commande de
      // demarrage n'a plus rien a envoyer, et se resout sans rien casser.
      await expect(scriptLoads[0]).resolves.toBeUndefined();
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
