const { createMemoryRoutingStore, createRedisRoutingStore, createPostgresRoutingStore } = require('../src');
const increment = (state) => ({ state: { count: (state?.count || 0) + 1 }, value: (state?.count || 0) + 1 });

test('memory store serializes concurrent updates, isolates keys and returns copies', async () => {
  const store = createMemoryRoutingStore();
  const results = await Promise.all(Array.from({ length: 50 }, () => store.update('a', increment)));
  expect(new Set(results).size).toBe(50); expect(await store.read('a')).toEqual({ count: 50 });
  const copy = await store.read('a'); copy.count = 0; expect((await store.read('a')).count).toBe(50);
  expect(await store.read('b')).toBeNull(); await store.update('a', () => ({ state: null })); expect(await store.read('a')).toBeNull();
});

test('memory store recovers after a rejected update without losing prior state', async () => {
  const store = createMemoryRoutingStore(); await store.update('a', increment);
  await expect(store.update('a', () => { throw new Error('broken'); })).rejects.toThrow('broken');
  expect(await store.update('a', increment)).toBe(2);
});

test('Redis CAS retries stale reads atomically, uses prefix/TTL, and deletes on reset', async () => {
  const data = new Map(); const client = {
    get: jest.fn(async (key) => data.get(key) || null),
    eval: jest.fn(async (_script, { keys, arguments: args }) => {
      if ((data.get(keys[0]) || '') !== args[0]) return 0;
      if (args[1]) data.set(keys[0], args[1]); else data.delete(keys[0]);
      return 1;
    })
  };
  const a = createRedisRoutingStore({ client, prefix: 'app:', maxRetries: 100 });
  const b = createRedisRoutingStore({ client, prefix: 'app:', maxRetries: 100 });
  await Promise.all(Array.from({ length: 20 }, (_, at) => (at % 2 ? a : b).update('model', increment)));
  expect(await a.read('model')).toEqual({ count: 20 });
  expect(client.eval.mock.calls[0][1]).toMatchObject({ keys: ['app:model'], arguments: expect.arrayContaining(['172800000']) });
  await a.update('model', () => ({ state: null })); expect(await a.read('model')).toBeNull();
});

test('Redis errors and repeated contention never silently reset quotas in RAM', async () => {
  const client = { get: async () => null, eval: async () => 0 };
  await expect(createRedisRoutingStore({ client, maxRetries: 2 }).update('m', increment)).rejects.toThrow('AI_STATE_CONTENTION');
  client.get = async () => { throw new Error('offline'); };
  await expect(createRedisRoutingStore({ client }).read('m')).rejects.toThrow('offline');
});

test('Postgres initializes explicitly, locks before first insertion, commits, rolls back and releases', async () => {
  let state;
  let fail = false;
  const connection = {
    query: jest.fn(async (sql, params) => {
      if (sql.startsWith('SELECT state')) return { rows: state ? [{ state }] : [] };
      if (sql.startsWith('INSERT')) { if (fail) throw new Error('write failed'); state = JSON.parse(params[1]); }
      if (sql.startsWith('DELETE')) state = undefined;
      return { rows: [] };
    }), release: jest.fn()
  };
  const pool = { connect: jest.fn(async () => connection), query: jest.fn(connection.query) };
  const store = createPostgresRoutingStore({ pool, table: 'test_state' });
  expect(pool.query).not.toHaveBeenCalled(); await store.initialize();
  expect(pool.query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS test_state');
  expect(await store.update('m', increment)).toBe(1); expect(await store.read('m')).toEqual({ count: 1 });
  const sql = connection.query.mock.calls.map(([query]) => query);
  expect(sql.indexOf('BEGIN')).toBeLessThan(sql.findIndex((query) => query.includes('pg_advisory_xact_lock')));
  expect(sql.findIndex((query) => query.includes('pg_advisory_xact_lock'))).toBeLessThan(sql.findIndex((query) => query.startsWith('SELECT state')));
  expect(sql).toContain('COMMIT');
  fail = true; await expect(store.update('m', increment)).rejects.toThrow('write failed');
  expect(connection.query.mock.calls.at(-1)[0]).toBe('ROLLBACK'); expect(connection.release).toHaveBeenCalledTimes(2);
  fail = false; await store.update('m', () => ({ state: null })); expect(await store.read('m')).toBeNull();
  expect(() => createPostgresRoutingStore({ pool, table: 'bad; table' })).toThrow('INVALID_STATE_TABLE');
});
