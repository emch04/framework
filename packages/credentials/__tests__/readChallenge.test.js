const { createReadChallenge, createMemoryReadChallengeStore, createMongoReadChallengeStore } = require('../src');
const scope = { tenant: 'org', environment: 'production' };
const value = ['private', 'fixture'].join('-');
const vault = () => ({ scope, get: jest.fn(async () => value) });
test('injected verifier authorizes exactly one bound scoped/versioned read', async () => {
  const verify = jest.fn(async ({ proof }) => proof === 'verified');
  const challenge = createReadChallenge({ store: createMemoryReadChallengeStore(), verify });
  const record = await challenge.request('owner', { scope, key: 'KEY', version: 2 });
  const target = vault();
  expect(record.nonce.length).toBeGreaterThan(32);
  expect(await challenge.read('owner', record.id, 'verified', target)).toBe(value);
  expect(target.get).toHaveBeenCalledWith('KEY', { version: 2 });
  await expect(challenge.read('owner', record.id, 'verified', target)).rejects.toThrow('refused');
  expect(target.get).toHaveBeenCalledTimes(1);
});
test('concurrent consumption admits only one verification', async () => {
  const verify = jest.fn(async () => true);
  const challenge = createReadChallenge({ store: createMemoryReadChallengeStore(), verify });
  const record = await challenge.request('owner', { scope, key: 'KEY' });
  const target = vault();
  const results = await Promise.allSettled([challenge.read('owner', record.id, null, target), challenge.read('owner', record.id, null, target)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(verify).toHaveBeenCalledTimes(1);
});
test('wrong subject cannot consume another subject challenge', async () => {
  const challenge = createReadChallenge({ store: createMemoryReadChallengeStore(), verify: async () => true });
  const record = await challenge.request('owner', { scope, key: 'KEY' });
  const target = vault();
  await expect(challenge.read('attacker', record.id, null, target)).rejects.toThrow('refused');
  expect(await challenge.read('owner', record.id, null, target)).toBe(value);
});
test.each([false, 'true', 'throw'])('failed verifier %s burns challenge and sanitizes error', async result => {
  const challenge = createReadChallenge({ store: createMemoryReadChallengeStore(), verify: async () => { if (result === 'throw') throw new Error(value); return result; } });
  const record = await challenge.request('owner', { scope, key: 'KEY' });
  const target = vault();
  await expect(challenge.read('owner', record.id, null, target)).rejects.toThrow('Credential read challenge refused.');
  await expect(challenge.read('owner', record.id, null, target)).rejects.toThrow('refused');
  expect(target.get).not.toHaveBeenCalled();
});
test('expiration at boundary and during verification blocks read', async () => {
  let at = 1000;
  const verify = jest.fn(async () => { at += 100; return true; });
  const challenge = createReadChallenge({ store: createMemoryReadChallengeStore(), verify, now: () => at, ttlMs: 100 });
  const first = await challenge.request('owner', { scope, key: 'KEY' });
  at = 1100;
  await expect(challenge.read('owner', first.id, null, vault())).rejects.toThrow('refused');
  expect(verify).not.toHaveBeenCalled();
  const second = await challenge.request('owner', { scope, key: 'KEY' });
  await expect(challenge.read('owner', second.id, null, vault())).rejects.toThrow('refused');
});
test.each([{ ...scope, tenant: 'other' }, { ...scope, environment: 'development' }, null])('different vault scope is refused', async other => {
  const verify = jest.fn(async () => true);
  const challenge = createReadChallenge({ store: createMemoryReadChallengeStore(), verify });
  const record = await challenge.request('owner', { scope, key: 'KEY' });
  await expect(challenge.read('owner', record.id, null, { ...vault(), scope: other })).rejects.toThrow('refused');
  expect(verify).not.toHaveBeenCalled();
});
test('configuration and target validation refuse unsafe TTL and invalid versions', async () => {
  const options = { store: createMemoryReadChallengeStore(), verify: async () => true };
  for (const ttlMs of [0, -1, Infinity, 300001]) expect(() => createReadChallenge({ ...options, ttlMs })).toThrow('ttlMs');
  expect(() => createReadChallenge({})).toThrow('atomic');
  const challenge = createReadChallenge(options);
  for (const target of [{}, { key: 'KEY', version: 0 }, { key: 'KEY', scope: {} }]) await expect(challenge.request('owner', target)).rejects.toThrow();
});
test('Mongo read challenge consumes with atomic subject filter and direct document result', async () => {
  const collection = { insertOne: jest.fn(), findOneAndDelete: jest.fn(async () => null) };
  const store = createMongoReadChallengeStore({ collection });
  const record = { id: 'id', subjectId: '42', key: 'KEY' };
  await store.save(record);
  expect(collection.insertOne).toHaveBeenCalledWith({ ...record, _id: 'id' });
  expect(await store.consume('id', 42)).toBeNull();
  expect(collection.findOneAndDelete).toHaveBeenCalledWith({ _id: 'id', subjectId: '42' }, { includeResultMetadata: false });
  expect(() => createMongoReadChallengeStore({ collection: {} })).toThrow('collection');
});

test('invalid stored expiration and identity cannot authorize a read', async () => {
  for (const record of [
    { id: 'id', subjectId: 'owner', expiresAt: 'invalid' },
    { id: 'id', subjectId: 'other', expiresAt: new Date(Date.now() + 10000) }
  ]) {
    const verify = jest.fn(async () => true);
    const challenge = createReadChallenge({ store: { save() {}, consume: async () => record }, verify });
    await expect(challenge.read('owner', 'id', null, vault())).rejects.toThrow('refused');
    expect(verify).not.toHaveBeenCalled();
  }
});
