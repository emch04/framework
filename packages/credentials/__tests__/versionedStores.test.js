/* global structuredClone */
const { createMemoryVersionedCredentialStore, createMongoVersionedCredentialStore } = require('../src');
const scope = { tenant: 'org', environment: 'production' };
const clone = value => value == null ? value : structuredClone(value);
/** Simulates the actual revision compare-and-swap and unique _id contracts. */
function mongo() {
  const docs = new Map();
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value || (value === null && row[key] == null));
  return {
    docs,
    find: jest.fn(filter => ({ toArray: async () => [...docs.values()].filter(row => matches(row, filter)).map(clone) })),
    findOne: jest.fn(async filter => clone(docs.get(filter._id) || null)),
    insertOne: jest.fn(async doc => {
      if (docs.has(doc._id)) { const error = new Error('duplicate'); error.code = 11000; throw error; }
      docs.set(doc._id, clone(doc));
    }),
    updateOne: jest.fn(async (filter, update) => {
      const row = docs.get(filter._id);
      if (!row || !matches(row, filter)) return { matchedCount: 0 };
      docs.set(filter._id, { ...row, ...clone(update.$set) });
      return { matchedCount: 1 };
    })
  };
}
const build = (key, namespace, at, value) => version => ({ key, ...(namespace || {}), version, value, secret: true, updatedAt: new Date(at), updatedBy: 'owner' });
describe.each(['memory', 'mongo'])('%s versioned store', kind => {
  const create = () => kind === 'memory' ? createMemoryVersionedCredentialStore() : createMongoVersionedCredentialStore({ collection: mongo() });
  test('concurrent writes do not lose or reuse versions', async () => {
    const store = create();
    const written = await Promise.all(Array.from({ length: 12 }, (_, i) => store.appendVersion('KEY', scope, build('KEY', scope, 1000, `encrypted-${i}`), 100)));
    expect(new Set(written.map(row => row.version)).size).toBe(12);
    expect((await store.findAll(scope))[0].version).toBe(12);
    expect(await store.listVersions('KEY', scope)).toHaveLength(12);
  });
  test('flat and scoped namespaces, history and purge never cross boundaries', async () => {
    const store = create();
    const other = { ...scope, tenant: 'other' };
    for (const namespace of [undefined, scope, other]) {
      await store.appendVersion('KEY', namespace, build('KEY', namespace, 1000, 'encrypted-old'), 100);
      await store.appendVersion('KEY', namespace, build('KEY', namespace, 2000, 'encrypted-new'), 100);
    }
    expect(await store.findAll()).toHaveLength(1);
    expect(await store.findAll(scope)).toHaveLength(1);
    expect(await store.purgeVersions(new Date(2100), scope)).toBe(1);
    expect(await store.purgeVersions(new Date(2100), scope)).toBe(0);
    expect(await store.findVersion('KEY', 1, scope)).not.toHaveProperty('value');
    expect(await store.findVersion('KEY', 1, other)).toHaveProperty('value');
    expect(await store.findVersion('KEY', 1)).toHaveProperty('value');
    expect(await store.findVersion('KEY', 2, scope)).toHaveProperty('value');
    expect(await store.findVersion('MISSING', 1, scope)).toBeNull();
    expect(await store.listVersions('MISSING', scope)).toEqual([]);
    expect((await store.listVersions('KEY', scope))[0]).not.toHaveProperty('value');
  });
  test('append clones data and validates builder identity', async () => {
    const store = create();
    await expect(store.appendVersion('KEY', scope, build('WRONG', scope, 1000, 'encrypted'), 100)).rejects.toThrow('scope');
    await expect(store.appendVersion('KEY', scope, () => ({ key: 'KEY', version: 9 }), 100)).rejects.toThrow('row');
    await store.appendVersion('KEY', scope, build('KEY', scope, 1000, 'encrypted'), 100);
    const row = await store.findVersion('KEY', 1, scope);
    row.value = 'mutated';
    expect((await store.findVersion('KEY', 1, scope)).value).toBe('encrypted');
    await expect(store.upsert({ key: 'KEY', value: 'encrypted' })).rejects.toThrow('appendVersion');
  });
});
test('Mongo caps reads and checks readiness for every operation', async () => {
  const collection = mongo();
  let ready = true;
  const store = createMongoVersionedCredentialStore({ collection, isReady: () => ready, maxTimeMS: 123 });
  await store.findAll(scope);
  expect(collection.find).toHaveBeenCalledWith(scope, { maxTimeMS: 123 });
  await store.findVersion('KEY', 1, scope);
  expect(collection.findOne.mock.calls[0][1]).toEqual({ maxTimeMS: 123 });
  ready = false;
  for (const call of [() => store.findAll(), () => store.listVersions('KEY'), () => store.findVersion('KEY', 1),
    () => store.appendVersion('KEY', scope, build('KEY', scope, 1000, 'encrypted'), 100), () => store.purgeVersions(new Date())]) {
    await expect(call()).rejects.toThrow('unavailable');
  }
});
test('Mongo refuses invalid setup, storage failure and excessive contention', async () => {
  expect(() => createMongoVersionedCredentialStore({ collection: {} })).toThrow('collection');
  const collection = mongo();
  collection.insertOne.mockRejectedValue(new Error('internal detail'));
  await expect(createMongoVersionedCredentialStore({ collection }).appendVersion('KEY', scope, build('KEY', scope, 1000, 'encrypted'), 100)).rejects.toThrow('Credential store write failed.');
  const busy = mongo();
  const store = createMongoVersionedCredentialStore({ collection: busy });
  await store.appendVersion('KEY', scope, build('KEY', scope, 1000, 'encrypted'), 100);
  busy.updateOne.mockResolvedValue({ matchedCount: 0 });
  await expect(store.appendVersion('KEY', scope, build('KEY', scope, 2000, 'encrypted'), 100)).rejects.toThrow('contention');
});
