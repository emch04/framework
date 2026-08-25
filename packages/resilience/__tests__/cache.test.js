const { createCache, createMemoryCacheStore } = require('../src');

describe('memory store', () => {
  test('a value expires at its TTL', async () => {
    let time = 0;
    const store = createMemoryCacheStore({ now: () => time });

    await store.set('k', 'v', 60);
    expect(await store.get('k')).toBe('v');

    time = 61_000;
    expect(await store.get('k')).toBeNull();
  });

  test('eviction drops the LEAST RECENTLY USED, not the oldest write', async () => {
    const store = createMemoryCacheStore({ maxEntries: 2 });

    await store.set('a', '1', 60);
    await store.set('b', '2', 60);
    await store.get('a');           // 'a' is now the most recent
    await store.set('c', '3', 60);  // evicts 'b'

    expect(await store.get('a')).toBe('1');
    expect(await store.get('b')).toBeNull();
    expect(await store.get('c')).toBe('3');
  });

  test('the cap holds — a cache that only grows is a slow leak', async () => {
    const store = createMemoryCacheStore({ maxEntries: 10 });

    for (let i = 0; i < 50; i += 1) await store.set(`k${i}`, 'v', 60);

    expect(store.size()).toBe(10);
  });
});

describe('cache', () => {
  test('round-trips structured values', async () => {
    const cache = createCache();

    await cache.set('user', { id: 1, roles: ['admin'] });

    expect(await cache.get('user')).toEqual({ id: 1, roles: ['admin'] });
  });

  test('a miss is null, and an invalidated key misses again', async () => {
    const cache = createCache();
    await cache.set('k', 'v');

    await cache.invalidate('k');

    expect(await cache.get('k')).toBeNull();
  });

  test('a BROKEN store reads as a miss — the cache must never take a request down', async () => {
    const warnings = [];
    const cache = createCache({
      store: {
        get: async () => { throw new Error('redis down'); },
        set: async () => { throw new Error('redis down'); },
        delete: async () => { throw new Error('redis down'); }
      },
      logger: { warn: (m) => warnings.push(m) }
    });

    await expect(cache.get('k')).resolves.toBeNull();
    await expect(cache.set('k', 'v')).resolves.toBeUndefined();
    await expect(cache.invalidate('k')).resolves.toBeUndefined();
    expect(warnings.length).toBe(3);
  });

  test('corrupt JSON in the store reads as a miss, not a crash', async () => {
    const cache = createCache({
      store: { get: async () => '{not json', set: async () => {}, delete: async () => {} },
      logger: { warn: () => {} }
    });

    expect(await cache.get('k')).toBeNull();
  });

  test('a prefix keeps two caches from colliding on one store', async () => {
    const shared = createMemoryCacheStore();
    const a = createCache({ store: shared, prefix: 'serviceA' });
    const b = createCache({ store: shared, prefix: 'serviceB' });

    await a.set('user', 'Jean');
    await b.set('user', 'Marie');

    expect(await a.get('user')).toBe('Jean');
    expect(await b.get('user')).toBe('Marie');
  });
});

describe('remember — cache-aside done once', () => {
  test('computes on a miss, serves from cache after', async () => {
    const cache = createCache();
    let computations = 0;

    const first = await cache.remember('stats', async () => { computations += 1; return { total: 42 }; });
    const second = await cache.remember('stats', async () => { computations += 1; return { total: 99 }; });

    expect(first).toEqual({ total: 42 });
    expect(second).toEqual({ total: 42 });
    expect(computations).toBe(1);
  });

  test('under concurrency, ONE computation runs per key — no stampede', async () => {
    /* The second a popular entry expires, every request would otherwise hit
       the database with the same query at once. */
    const cache = createCache();
    let computations = 0;
    const slow = async () => {
      computations += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'result';
    };

    const results = await Promise.all([
      cache.remember('k', slow), cache.remember('k', slow), cache.remember('k', slow)
    ]);

    expect(results).toEqual(['result', 'result', 'result']);
    expect(computations).toBe(1);
  });

  test('different keys compute independently', async () => {
    const cache = createCache();
    let computations = 0;
    const produce = async () => { computations += 1; return 'x'; };

    await Promise.all([cache.remember('a', produce), cache.remember('b', produce)]);

    expect(computations).toBe(2);
  });

  test('null is NOT cached — "nothing" today must not shadow "something" tomorrow', async () => {
    const cache = createCache();
    let calls = 0;

    await cache.remember('k', async () => { calls += 1; return null; });
    await cache.remember('k', async () => { calls += 1; return 'found now'; });

    expect(calls).toBe(2);
    expect(await cache.get('k')).toBe('found now');
  });

  test('a failed computation is not cached, and the next call tries again', async () => {
    const cache = createCache();
    let calls = 0;

    await cache.remember('k', async () => { calls += 1; throw new Error('db down'); }).catch(() => {});
    const second = await cache.remember('k', async () => { calls += 1; return 'ok'; });

    expect(calls).toBe(2);
    expect(second).toBe('ok');
  });
});
