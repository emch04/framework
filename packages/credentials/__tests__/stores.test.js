const {
  createMemoryChallengeStore,
  createMemoryCredentialStore,
  createMongoChallengeStore,
  createMongoCredentialStore
} = require('../src');

function fakeCollection() {
  const rows = new Map();
  const calls = { find: [], updateOne: [] };
  return {
    calls,
    rows,
    find(filter, options) {
      calls.find.push({ filter, options });
      const cursor = {
        maxTimeMS(ms) { calls.find[calls.find.length - 1].maxTimeMS = ms; return cursor; },
        async toArray() { return [...rows.values()]; }
      };
      return cursor;
    },
    async findOne(filter) {
      return rows.get(filter.subject) || null;
    },
    async updateOne(filter, update, options) {
      calls.updateOne.push({ filter, update, options });
      const id = filter.key || filter.subject;
      rows.set(id, { ...(rows.get(id) || {}), ...update.$set });
    }
  };
}

describe('memory stores', () => {
  test('a credential round-trips and is copied, not aliased', async () => {
    const store = createMemoryCredentialStore();
    const row = { key: 'K', value: 'v', secret: true };

    await store.upsert(row);
    row.value = 'mutated-after-the-fact';

    const [stored] = await store.findAll();
    expect(stored.value).toBe('v');
    expect(stored.updatedAt).toBeInstanceOf(Date);
  });

  test('upserting the same key replaces it instead of duplicating', async () => {
    const store = createMemoryCredentialStore();

    await store.upsert({ key: 'K', value: 'first' });
    await store.upsert({ key: 'K', value: 'second' });

    expect(await store.findAll()).toHaveLength(1);
  });

  test('a challenge round-trips, and an unknown subject is null', async () => {
    const store = createMemoryChallengeStore();

    await store.save('user-1', { attempts: 0, codeHash: 'abc' });

    expect(await store.find('user-1')).toMatchObject({ codeHash: 'abc' });
    expect(await store.find('user-2')).toBeNull();
  });
});

describe('mongo credential store', () => {
  test('reads are capped so a slow database cannot hang a payment', async () => {
    const collection = fakeCollection();
    const store = createMongoCredentialStore({ collection, maxTimeMS: 1500 });

    await store.findAll();

    expect(collection.calls.find[0].maxTimeMS).toBe(1500);
  });

  test('never asks for fields it has no business reading', async () => {
    const collection = fakeCollection();
    await createMongoCredentialStore({ collection }).findAll();

    expect(collection.calls.find[0].options.projection).toMatchObject({ key: 1, value: 1, secret: 1 });
  });

  test('a disconnected driver returns nothing instead of queueing forever', async () => {
    const collection = fakeCollection();
    const store = createMongoCredentialStore({ collection, isReady: () => false });

    expect(await store.findAll()).toEqual([]);
    expect(collection.calls.find).toHaveLength(0);
  });

  test('upsert writes by key and stamps the time', async () => {
    const collection = fakeCollection();
    const store = createMongoCredentialStore({ collection });

    await store.upsert({ key: 'K', value: 'ciphertext', secret: true });

    const [call] = collection.calls.updateOne;
    expect(call.filter).toEqual({ key: 'K' });
    expect(call.options).toEqual({ upsert: true });
    expect(call.update.$set.updatedAt).toBeInstanceOf(Date);
  });

  test('a round-trip through the driver adapter returns what was written', async () => {
    const collection = fakeCollection();
    const store = createMongoCredentialStore({ collection });

    await store.upsert({ key: 'K', value: 'ciphertext', secret: true });

    expect(await store.findAll()).toEqual([expect.objectContaining({ key: 'K', value: 'ciphertext' })]);
  });

  test('wiring without a collection is refused up front', () => {
    expect(() => createMongoCredentialStore({})).toThrow(/collection/);
    expect(() => createMongoChallengeStore({})).toThrow(/collection/);
  });
});

describe('mongo challenge store', () => {
  test('a challenge is keyed by subject and round-trips', async () => {
    const collection = fakeCollection();
    const store = createMongoChallengeStore({ collection });

    await store.save('user-1', { codeHash: 'abc', attempts: 0 });

    expect(await store.find('user-1')).toMatchObject({ subject: 'user-1', codeHash: 'abc' });
    expect(await store.find('user-2')).toBeNull();
  });

  test('a numeric id and its string form are the same subject', async () => {
    const collection = fakeCollection();
    const store = createMongoChallengeStore({ collection });

    await store.save(42, { codeHash: 'abc' });

    expect(await store.find('42')).toMatchObject({ codeHash: 'abc' });
  });
});
