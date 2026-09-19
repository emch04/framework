const {
  createJobLock,
  createMemoryLockStore,
  createMongoLockStore,
  createRedisLockStore
} = require('../src');

/* Four instances of the same app share one store: without the lock, one
   scheduled reminder went out four times in the same second. */
function cluster(count = 4) {
  let time = 0;
  const store = createMemoryLockStore();
  const instances = Array.from({ length: count }, (_, i) =>
    createJobLock({ store, owner: `instance-${i}`, now: () => time }));
  return { store, instances, advance: (ms) => { time += ms; } };
}

describe('claim', () => {
  test('ONE instance out of four gets the lock', async () => {
    const { instances } = cluster();

    const results = await Promise.all(instances.map((lock) => lock.claim('reminders', 60_000)));

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('the same lock cannot be taken twice — not even by its own holder', async () => {
    const { instances: [a] } = cluster(1);

    expect(await a.claim('reminders', 60_000)).toBe(true);
    /* A second tick of the same instance is a second run: it must skip too. */
    expect(await a.claim('reminders', 60_000)).toBe(false);
  });

  test('different jobs do not block each other', async () => {
    const { instances: [a, b] } = cluster(2);

    expect(await a.claim('reminders', 60_000)).toBe(true);
    expect(await b.claim('backup', 60_000)).toBe(true);
  });

  test('the lock EXPIRES — a dead holder does not block the job forever', async () => {
    const { instances: [dead, alive], advance } = cluster(2);
    await dead.claim('reminders', 60_000);

    advance(59_999);
    expect(await alive.claim('reminders', 60_000)).toBe(false);

    advance(1);
    expect(await alive.claim('reminders', 60_000)).toBe(true);
  });

  test('a non-positive hold is refused — it would be a lock nobody respects', async () => {
    const { instances: [a] } = cluster(1);

    await expect(a.claim('reminders', 0)).rejects.toThrow(TypeError);
    await expect(a.claim('reminders', Number.NaN)).rejects.toThrow(TypeError);
  });

  test('a store failure is THROWN — a duplicate beats a job that silently never runs', async () => {
    const lock = createJobLock({
      store: { acquire: async () => { throw new Error('store unreachable'); }, release: async () => false }
    });

    await expect(lock.claim('reminders', 1000)).rejects.toThrow('store unreachable');
  });

  test('a store is required', () => {
    expect(() => createJobLock({})).toThrow(TypeError);
  });

  test('the default owner is unique per lock, not just a pid shared by every container', () => {
    const store = createMemoryLockStore();
    expect(createJobLock({ store }).owner).not.toBe(createJobLock({ store }).owner);
  });
});

describe('release', () => {
  test('the holder can release early', async () => {
    const { instances: [a, b] } = cluster(2);
    await a.claim('reminders', 60_000);

    expect(await a.release('reminders')).toBe(true);
    expect(await b.claim('reminders', 60_000)).toBe(true);
  });

  test('another owner CANNOT release the lock', async () => {
    const { instances: [a, b, c] } = cluster(3);
    await a.claim('reminders', 60_000);

    expect(await b.release('reminders')).toBe(false);
    expect(await c.claim('reminders', 60_000)).toBe(false);
  });

  test('a late holder does not free the lock a NEWER holder took after expiry', async () => {
    const { instances: [slow, fresh, third], advance } = cluster(3);
    await slow.claim('reminders', 1000);
    advance(1000);
    await fresh.claim('reminders', 1000);

    /* The slow instance finishes and releases what it believes is its lock. */
    expect(await slow.release('reminders')).toBe(false);
    expect(await third.claim('reminders', 1000)).toBe(false);
  });
});

describe('run', () => {
  test('runs the job for the holder only', async () => {
    const { instances } = cluster();
    const job = jest.fn(async () => 'done');

    const results = await Promise.all(instances.map((lock) => lock.run('reminders', 60_000, job)));

    expect(job).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r === 'done')).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(3);
  });

  test('by default the lock is KEPT after the job — a late timer must not rerun the tick', async () => {
    const { instances: [a, b] } = cluster(2);
    await a.run('reminders', 60_000, async () => 'done');

    expect(await b.claim('reminders', 60_000)).toBe(false);
  });

  test('with `release: true` the lock is freed after the job, even when it throws', async () => {
    const { instances: [a, b] } = cluster(2);

    await expect(a.run('reminders', 60_000, async () => { throw new Error('job failed'); }, { release: true }))
      .rejects.toThrow('job failed');

    expect(await b.claim('reminders', 60_000)).toBe(true);
  });

  test('a failed early release does not replace the job result', async () => {
    const store = createMemoryLockStore();
    store.release = async () => { throw new Error('store unreachable'); };
    const lock = createJobLock({ store, owner: 'a' });

    expect(await lock.run('reminders', 1000, async () => 42, { release: true })).toBe(42);
  });
});

describe('mongo store', () => {
  test('acquire is an upsert filtered on expiry', async () => {
    const collection = { updateOne: jest.fn(async () => ({})), deleteOne: jest.fn() };
    const store = createMongoLockStore(collection);

    expect(await store.acquire({ key: 'k', owner: 'a', holdMs: 1000, now: 5000 })).toBe(true);

    const [filter, update, options] = collection.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'k', expiresAt: { $lte: new Date(5000) } });
    expect(update.$set).toEqual({ owner: 'a', expiresAt: new Date(6000) });
    expect(options).toEqual({ upsert: true });
  });

  test('a duplicate key (11000) means taken, not failed', async () => {
    const store = createMongoLockStore({
      updateOne: async () => { throw Object.assign(new Error('dup'), { code: 11000 }); },
      deleteOne: jest.fn()
    });

    expect(await store.acquire({ key: 'k', owner: 'a', holdMs: 1000, now: 0 })).toBe(false);
  });

  test('any other error is thrown', async () => {
    const store = createMongoLockStore({
      updateOne: async () => { throw new Error('db down'); },
      deleteOne: jest.fn()
    });

    await expect(store.acquire({ key: 'k', owner: 'a', holdMs: 1000, now: 0 })).rejects.toThrow('db down');
  });

  test('release deletes only the document owned by the caller', async () => {
    const collection = { updateOne: jest.fn(), deleteOne: jest.fn(async () => ({ deletedCount: 0 })) };
    const store = createMongoLockStore(collection);

    expect(await store.release({ key: 'k', owner: 'b' })).toBe(false);
    expect(collection.deleteOne).toHaveBeenCalledWith({ _id: 'k', owner: 'b' });
  });
});

describe('redis store', () => {
  /* A tiny Redis double: SET NX PX and the compare-and-delete script. */
  function fakeRedis() {
    const keys = new Map();
    const command = jest.fn(async (args) => {
      if (args[0] === 'SET') {
        const [, key, value] = args;
        if (keys.has(key)) return null;
        keys.set(key, value);
        return 'OK';
      }
      if (args[0] === 'EVAL') {
        const [, , , key, owner] = args;
        if (keys.get(key) !== owner) return 0;
        keys.delete(key);
        return 1;
      }
      throw new Error(`unexpected ${args[0]}`);
    });
    return { command, keys };
  }

  test('SET NX PX with the hold in milliseconds', async () => {
    const redis = fakeRedis();
    const store = createRedisLockStore(redis);

    expect(await store.acquire({ key: 'k', owner: 'a', holdMs: 1500, now: 0 })).toBe(true);
    expect(await store.acquire({ key: 'k', owner: 'b', holdMs: 1500, now: 0 })).toBe(false);
    expect(redis.command.mock.calls[0][0]).toEqual(['SET', 'k', 'a', 'NX', 'PX', '1500']);
  });

  test('release is an atomic compare-and-delete — never a plain DEL', async () => {
    const redis = fakeRedis();
    const store = createRedisLockStore(redis);
    await store.acquire({ key: 'k', owner: 'a', holdMs: 1000, now: 0 });

    expect(await store.release({ key: 'k', owner: 'b' })).toBe(false);
    expect(redis.keys.has('k')).toBe(true);
    expect(await store.release({ key: 'k', owner: 'a' })).toBe(true);
    expect(redis.command.mock.calls.every(([args]) => args[0] !== 'DEL')).toBe(true);
  });
});
