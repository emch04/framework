const crypto = require('crypto');
const { createCredentialVault, createCredentialCatalog, createMemoryCredentialStore,
  createMongoCredentialStore, createMemoryVersionedCredentialStore, createContextCipher } = require('../src');
const catalog = createCredentialCatalog({ spaces: [{ id: 'test', keys: [{ key: 'KEY' }, { key: 'PUBLIC', secret: false }] }] });
const cipher = createContextCipher({ key: crypto.randomBytes(32) });
const value = ['private', 'fixture'].join('-');
const scope = { tenant: 'org', environment: 'production' };
const make = options => createCredentialVault({ store: createMemoryCredentialStore(), catalog, cipher, env: { KEY: 'env' }, cacheMs: 0, ...options });
test.each(['get', 'getMany', 'stored', 'status'])('strict %s refuses store failure with a safe event', async method => {
  const logger = { warn: jest.fn(), error: jest.fn() };
  const vault = make({ strict: true, logger, store: { findAll: async () => { throw new Error(value); }, upsert: jest.fn() } });
  await expect(vault[method](method === 'getMany' ? ['KEY'] : 'KEY')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNREADABLE' });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(value);
});
test.each(['get', 'getMany', 'stored', 'status'])('strict %s refuses corrupt ciphertext', async method => {
  const vault = make({ strict: true, store: createMemoryCredentialStore([{ key: 'KEY', value }]) });
  await expect(vault[method](method === 'getMany' ? ['KEY'] : 'KEY')).rejects.toMatchObject({ code: 'CREDENTIAL_VALUE_UNREADABLE' });
});
test('fallback is compatible by default, none prevents absent and unreadable env reads', async () => {
  const store = createMemoryCredentialStore([{ key: 'KEY', value }]);
  expect(await make({ store }).get('KEY')).toBe('env');
  const vault = make({ store, fallback: 'none' });
  expect(await vault.get('KEY')).toBeNull();
  expect(await vault.getMany(['KEY'])).toEqual({ KEY: null });
  expect((await vault.status()).spaces[0].keys[1].source).toBe('absent');
});
test('strict distinguishes absence from a disconnected Mongo driver', async () => {
  const collection = { find: jest.fn() };
  const vault = make({ strict: true, store: createMongoCredentialStore({ collection, isReady: () => false }) });
  await expect(vault.get('KEY')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNREADABLE' });
  expect(collection.find).not.toHaveBeenCalled();
  expect(await make({ strict: true }).get('KEY')).toBe('env');
});
test('tenant/environment/flat namespaces isolate reads, writes, status and disconnect', async () => {
  const store = createMemoryCredentialStore();
  const a = make({ store, scope, fallback: 'none' });
  const b = make({ store, scope: { ...scope, tenant: 'other' }, fallback: 'none' });
  const c = make({ store, scope: { ...scope, environment: 'development' }, fallback: 'none' });
  const flat = make({ store, fallback: 'none' });
  await a.set('KEY', value);
  await b.set('KEY', 'other-value');
  await c.set('KEY', 'development-value');
  await flat.set('KEY', 'flat-value');
  expect(await a.get('KEY')).toBe(value);
  expect(await b.get('KEY')).toBe('other-value');
  expect(await c.get('KEY')).toBe('development-value');
  expect(await flat.get('KEY')).toBe('flat-value');
  await a.disconnect('KEY');
  expect(await a.get('KEY')).toBeNull();
  expect(await b.get('KEY')).toBe('other-value');
  expect((await a.status()).spaces[0].keys[0].source).toBe('disconnected');
});
test('a copied ciphertext fails in another namespace', async () => {
  const store = createMemoryCredentialStore();
  await make({ store, scope }).set('KEY', value);
  const [row] = await store.findAll(scope);
  await store.upsert({ ...row, tenant: 'other' });
  await expect(make({ store, scope: { ...scope, tenant: 'other' }, strict: true }).get('KEY')).rejects.toMatchObject({ code: 'CREDENTIAL_VALUE_UNREADABLE' });
});
test('history creates versions, expires retired values, purges ciphertext but keeps metadata', async () => {
  let at = 1000;
  const store = createMemoryVersionedCredentialStore();
  const onWrite = jest.fn();
  const vault = make({ store, history: true, scope, retentionMs: 100, now: () => at, onWrite });
  await vault.set('KEY', value, { updatedBy: 'owner' });
  at = 2000;
  await vault.set('KEY', 'replacement');
  expect(await vault.get('KEY')).toBe('replacement');
  expect(await vault.get('KEY', { version: 1 })).toBe(value);
  expect(await vault.get('KEY', { version: 99 })).toBeNull();
  expect(onWrite.mock.calls[1][0]).toMatchObject({ key: 'KEY', tenant: 'org', environment: 'production', version: 2, action: 'set' });
  expect(JSON.stringify(onWrite.mock.calls)).not.toContain(value);
  expect(JSON.stringify(await vault.listVersions('KEY'))).not.toContain(value);
  at = 2100;
  expect(await vault.get('KEY', { version: 1 })).toBeNull();
  expect(await vault.purgeVersions()).toBe(1);
  expect(await store.findVersion('KEY', 1, scope)).not.toHaveProperty('value');
  expect((await vault.listVersions('KEY'))[1]).toMatchObject({ version: 1, purged: true, updatedBy: 'owner' });
  await vault.disconnect('KEY');
  expect(await vault.get('KEY')).toBeNull();
  expect(await vault.get('KEY', { version: 3 })).toBeNull();
});
test('hook runs after commit and invalidation; failure declares committed write safely', async () => {
  let vault;
  const onWrite = jest.fn(async () => { expect(await vault.get('KEY')).toBe(value); });
  vault = make({ cacheMs: 60000, onWrite });
  expect(await vault.get('KEY')).toBe('env');
  await vault.set('KEY', value);
  expect(onWrite).toHaveBeenCalledTimes(1);
  const failing = make({ onWrite: () => { throw new Error(value); } });
  await expect(failing.set('KEY', value)).rejects.toMatchObject({ code: 'CREDENTIAL_AFTER_WRITE_FAILED', committed: true, message: 'Credential written, but onWrite failed.' });
  expect(await failing.get('KEY')).toBe(value);
});
test('failed write does not run the hook', async () => {
  const onWrite = jest.fn();
  const vault = make({ onWrite, store: { findAll: async () => [], upsert: async () => { throw new Error('offline'); } } });
  await expect(vault.set('KEY', value)).rejects.toThrow();
  expect(onWrite).not.toHaveBeenCalled();
});
test('TTL, explicit forget, and writes refresh cache', async () => {
  let at = 1000;
  const store = createMemoryCredentialStore();
  const vault = make({ store, cacheMs: 100, now: () => at });
  expect(await vault.get('KEY')).toBe('env');
  await make({ store }).set('KEY', value);
  expect(await vault.get('KEY')).toBe('env');
  at += 100;
  expect(await vault.get('KEY')).toBe(value);
  await make({ store }).disconnect('KEY');
  vault.forget();
  expect(await vault.get('KEY')).toBeNull();
});
test('an in-flight old read cannot repopulate the cache after a write', async () => {
  const actual = createMemoryCredentialStore();
  let release;
  let first = true;
  const store = { upsert: row => actual.upsert(row), findAll: async () => {
    const snapshot = await actual.findAll();
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return snapshot;
  } };
  const vault = make({ store, cacheMs: 60000 });
  const reading = vault.get('KEY');
  await new Promise(resolve => setImmediate(resolve));
  await vault.set('KEY', value);
  release();
  expect(await reading).toBe(value);
  expect(await vault.get('KEY')).toBe(value);
});
test('invalid configuration and unsupported scope/history fail before use', async () => {
  expect(() => make({ scope: { tenant: 'org' } })).toThrow();
  expect(() => make({ scope, store: { findAll() {}, upsert() {} } })).toThrow('scopes');
  expect(() => make({ history: true })).toThrow('versioned');
  for (const options of [{ cacheMs: -1 }, { retentionMs: -1 }, { fallback: 'bad' }, { onWrite: true }]) expect(() => make(options)).toThrow();
  await expect(make().get('KEY', { version: 1 })).rejects.toThrow('History');
  await expect(make().listVersions('KEY')).rejects.toThrow('History');
});

test('strict read does not serve an expired cache after a store outage', async () => {
  let at = 1000;
  let broken = false;
  const actual = createMemoryCredentialStore();
  const store = { upsert: row => actual.upsert(row), findAll: async () => {
    if (broken) throw new Error(value);
    return actual.findAll();
  } };
  const vault = make({ store, strict: true, cacheMs: 100, now: () => at });
  await vault.set('KEY', value);
  expect(await vault.get('KEY')).toBe(value);
  broken = true;
  at = 1100;
  await expect(vault.get('KEY')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNREADABLE' });
});
test('malformed or cross-scope adapter output fails closed', async () => {
  for (const rows of [null, {}, [null], [{ key: 'KEY', value, tenant: 'other', environment: 'production' }]]) {
    const store = { supportsScopes: true, findAll: async () => rows, upsert: jest.fn() };
    const vault = make({ strict: true, scope, store });
    await expect(vault.get('KEY')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNREADABLE' });
  }
});
test('historical reads keep the value guard and previous cipher', async () => {
  const store = createMemoryVersionedCredentialStore();
  const newer = createContextCipher({ key: crypto.randomBytes(32) });
  await make({ store, history: true, cipher }).set('KEY', value);
  const rotating = make({ store, history: true, cipher: newer, previousCipher: cipher, strict: true });
  expect(await rotating.get('KEY', { version: 1 })).toBe(value);
  await rotating.set('KEY', 'new-value');
  expect(await rotating.get('KEY')).toBe('new-value');
  const guard = { mayRead: () => false, mayWrite: () => ({ ok: true }) };
  expect(await make({ store, history: true, cipher: newer, previousCipher: cipher, guard }).get('KEY', { version: 1 })).toBeNull();
  await expect(rotating.get('KEY', { version: 0 })).rejects.toThrow('version');
});
test('zero retention expires an old value immediately but keeps the current value', async () => {
  const vault = make({ store: createMemoryVersionedCredentialStore(), history: true, retentionMs: 0 });
  await vault.set('KEY', value);
  await vault.set('KEY', 'new-value');
  expect(await vault.get('KEY', { version: 1 })).toBeNull();
  expect(await vault.purgeVersions()).toBe(1);
  expect(await vault.get('KEY')).toBe('new-value');
});

test('strict version metadata read failures have the same sanitized store error', async () => {
  const store = createMemoryVersionedCredentialStore();
  store.listVersions = async () => { throw new Error(value); };
  await expect(make({ store, history: true, strict: true }).listVersions('KEY')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNREADABLE' });
});
