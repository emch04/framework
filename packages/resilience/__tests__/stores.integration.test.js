const { randomUUID } = require('node:crypto');
const { createRedisLockStore, createMongoLockStore, createCache } = require('../src');
const redisUrl = process.env.REDIS_TEST_URL;
const mongoUrl = process.env.MONGO_TEST_URL;
const redisTest = redisUrl ? test : test.skip;
const mongoTest = mongoUrl ? test : test.skip;

redisTest('real Redis lock contention, ownership, expiry and TTL cache', async () => {
  const { createClient } = require('redis');
  const client = createClient({ url: redisUrl }); client.on('error', () => {});
  await client.connect();
  const prefix = `integration:${randomUUID()}`;
  const key = `${prefix}:lock`;
  const store = createRedisLockStore({ command: args => client.sendCommand(args) });
  try {
    const claims = await Promise.all(['a', 'b'].map(owner => store.acquire({ key, owner, holdMs: 150 })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = claims[0] ? 'a' : 'b';
    expect(await store.release({ key, owner: 'wrong' })).toBe(false);
    expect(await client.get(key)).toBe(owner);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(await store.acquire({ key, owner: 'new', holdMs: 1000 })).toBe(true);
    expect(await store.release({ key, owner })).toBe(false);
    expect(await store.release({ key, owner: 'new' })).toBe(true);
    const cache = createCache({ prefix, store: {
      get: key => client.get(key), set: (key, value, ttl) => client.set(key, value, { PX: Math.ceil(ttl * 1000) }), delete: key => client.del(key)
    } });
    await cache.set('item', { count: 2 }, 0.1);
    expect(await cache.get('item')).toEqual({ count: 2 });
    await new Promise(resolve => setTimeout(resolve, 130));
    expect(await cache.get('item')).toBeNull();
    await cache.set('item', 3); await cache.invalidate('item'); expect(await cache.get('item')).toBeNull();
    await client.disconnect();
    expect(await cache.get('item')).toBeNull();
    await expect(store.acquire({ key, owner: 'a', holdMs: 100 })).rejects.toThrow();
  } finally {
    if (client.isOpen) { await client.del([key, `${prefix}:item`]); await client.quit(); }
  }
});

mongoTest('real Mongo lock atomic contention, expiry and owner-only release', async () => {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(mongoUrl); await client.connect();
  const collection = client.db().collection(`integration_locks_${randomUUID().replaceAll('-', '')}`);
  const store = createMongoLockStore(collection);
  const now = Date.now();
  try {
    const claims = await Promise.all(['a', 'b'].map(owner => store.acquire({ key: 'job', owner, holdMs: 100, now })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = claims[0] ? 'a' : 'b';
    expect(await store.release({ key: 'job', owner: 'wrong' })).toBe(false);
    expect(await store.acquire({ key: 'job', owner: 'new', holdMs: 1000, now: now + 101 })).toBe(true);
    expect(await store.release({ key: 'job', owner })).toBe(false);
    expect(await store.release({ key: 'job', owner: 'new' })).toBe(true);
    expect(await collection.countDocuments()).toBe(0);
  } finally { await collection.drop(); await client.close(); }
  await expect(store.acquire({ key: 'job', owner: 'a', holdMs: 100, now })).rejects.toThrow();
});
