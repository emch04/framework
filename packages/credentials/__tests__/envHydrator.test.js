const { createFieldCipher, generateFieldEncryptionKey } = require('@astratra/security');
const {
  createCredentialCatalog,
  createCredentialVault,
  createEnvHydrator,
  createMemoryCredentialStore,
  createValueGuard
} = require('../src');

const catalog = createCredentialCatalog({
  spaces: [{
    id: 'all',
    label: 'All',
    keys: [{ key: 'MAIL_KEY', label: 'Mail' }, { key: 'SECRET_KEY', label: 'Secret' }]
  }]
});

function build(env = {}, guard) {
  const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
  const store = createMemoryCredentialStore();
  const vault = createCredentialVault({ store, catalog, cipher, env, guard, cacheMs: 0 });
  const hydrator = createEnvHydrator({ vault, env, guard });
  return { vault, hydrator, env };
}

describe('env hydrator', () => {
  test('a stored value replaces the one from the environment', async () => {
    const { vault, hydrator, env } = build({ MAIL_KEY: 'from-file' });
    await vault.set('MAIL_KEY', 'from-interface');

    const result = await hydrator.hydrate(['MAIL_KEY']);

    expect(env.MAIL_KEY).toBe('from-interface');
    expect(result).toEqual({ applied: 1, removed: 0, restored: 0 });
  });

  test('a disconnected key is DELETED, and the environment does not come back', async () => {
    const { vault, hydrator, env } = build({ MAIL_KEY: 'from-file' });
    await vault.disconnect('MAIL_KEY');

    const result = await hydrator.hydrate(['MAIL_KEY']);

    expect(env.MAIL_KEY).toBeUndefined();
    expect(result.removed).toBe(1);
  });

  test('a key removed from the store restores the ORIGINAL environment value', async () => {
    // A store whose rows can actually disappear — a wipe, a rollback, a
    // manual delete. This is the case the third branch exists for.
    const rows = new Map();
    const env = { MAIL_KEY: 'from-file' };
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const store = {
      async findAll() { return [...rows.values()]; },
      async upsert(row) { rows.set(row.key, row); }
    };
    const vault = createCredentialVault({ store, catalog, cipher, env, cacheMs: 0 });
    const hydrator = createEnvHydrator({ vault, env });

    await vault.set('MAIL_KEY', 'from-interface');
    await hydrator.hydrate(['MAIL_KEY']);
    expect(env.MAIL_KEY).toBe('from-interface');

    rows.delete('MAIL_KEY');
    const result = await hydrator.hydrate(['MAIL_KEY']);

    expect(env.MAIL_KEY).toBe('from-file');
    expect(result).toEqual({ applied: 0, removed: 0, restored: 1 });
  });

  test('a variable the file never had is deleted again, not left behind', async () => {
    const rows = new Map();
    const env = {};
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const store = {
      async findAll() { return [...rows.values()]; },
      async upsert(row) { rows.set(row.key, row); }
    };
    const vault = createCredentialVault({ store, catalog, cipher, env, cacheMs: 0 });
    const hydrator = createEnvHydrator({ vault, env });

    await vault.set('MAIL_KEY', 'from-interface');
    await hydrator.hydrate(['MAIL_KEY']);
    expect(env.MAIL_KEY).toBe('from-interface');

    rows.delete('MAIL_KEY');
    await hydrator.hydrate(['MAIL_KEY']);

    expect('MAIL_KEY' in env).toBe(false);
  });

  test('the originals are captured once, not re-read after the first pass', async () => {
    const rows = new Map();
    const env = { MAIL_KEY: 'from-file' };
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const store = {
      async findAll() { return [...rows.values()]; },
      async upsert(row) { rows.set(row.key, row); }
    };
    const vault = createCredentialVault({ store, catalog, cipher, env, cacheMs: 0 });
    const hydrator = createEnvHydrator({ vault, env });

    await vault.set('MAIL_KEY', 'first');
    await hydrator.hydrate(['MAIL_KEY']);
    await vault.set('MAIL_KEY', 'second');
    await hydrator.hydrate(['MAIL_KEY']);
    rows.delete('MAIL_KEY');
    await hydrator.hydrate(['MAIL_KEY']);

    // Not 'first', not 'second': what the file said before anything happened.
    expect(env.MAIL_KEY).toBe('from-file');
  });

  test('a later call covering new keys remembers their originals too', async () => {
    const rows = new Map();
    const env = { MAIL_KEY: 'mail-from-file', SECRET_KEY: 'secret-from-file' };
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const store = {
      async findAll() { return [...rows.values()]; },
      async upsert(row) { rows.set(row.key, row); }
    };
    const vault = createCredentialVault({ store, catalog, cipher, env, cacheMs: 0 });
    const hydrator = createEnvHydrator({ vault, env });

    await hydrator.hydrate(['MAIL_KEY']);
    await vault.set('SECRET_KEY', 'from-interface');
    await hydrator.hydrate(['MAIL_KEY', 'SECRET_KEY']);
    expect(env.SECRET_KEY).toBe('from-interface');

    rows.delete('SECRET_KEY');
    await hydrator.hydrate(['MAIL_KEY', 'SECRET_KEY']);

    expect(env.SECRET_KEY).toBe('secret-from-file');
  });

  test('the guard keeps a live value out of a non-production environment', async () => {
    const guard = createValueGuard({
      keys: ['SECRET_KEY'],
      decidingKey: 'SECRET_KEY',
      livePattern: /^sk_live_/,
      isProduction: () => false
    });
    const env = { SECRET_KEY: 'sk_test_local' };
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const store = createMemoryCredentialStore([
      { key: 'SECRET_KEY', value: cipher.encrypt('sk_live_real'), secret: true }
    ]);
    const vault = createCredentialVault({ store, catalog, cipher, env, guard });
    const hydrator = createEnvHydrator({ vault, env, guard });

    const result = await hydrator.hydrate(['SECRET_KEY']);

    expect(env.SECRET_KEY).toBe('sk_test_local');
    expect(result).toEqual({ applied: 0, removed: 0, restored: 0 });
  });

  test('an unreachable store leaves the environment exactly as it was', async () => {
    const env = { MAIL_KEY: 'from-file' };
    const broken = { async stored() { throw new Error('database down'); } };
    const warnings = [];
    const hydrator = createEnvHydrator({ vault: broken, env, logger: { warn: (m) => warnings.push(m) } });

    const result = await hydrator.hydrate(['MAIL_KEY']);

    expect(env.MAIL_KEY).toBe('from-file');
    expect(result).toEqual({ applied: 0, removed: 0, restored: 0 });
    expect(warnings).toHaveLength(1);
  });

  test('hydrating no keys does nothing at all', async () => {
    const { hydrator } = build();

    expect(await hydrator.hydrate([])).toEqual({ applied: 0, removed: 0, restored: 0 });
  });

  test('startRefresh keeps the environment current and can be stopped', async () => {
    jest.useFakeTimers();
    const { vault, hydrator, env } = build({ MAIL_KEY: 'from-file' });
    const changes = [];
    const stop = hydrator.startRefresh(['MAIL_KEY'], { intervalMs: 1000, onChange: (r) => changes.push(r) });

    await vault.set('MAIL_KEY', 'from-interface');
    await jest.advanceTimersByTimeAsync(1000);

    expect(env.MAIL_KEY).toBe('from-interface');
    expect(changes).toEqual([{ applied: 1, removed: 0, restored: 0 }]);

    stop();
    await vault.set('MAIL_KEY', 'later');
    await jest.advanceTimersByTimeAsync(5000);

    expect(env.MAIL_KEY).toBe('from-interface');
    jest.useRealTimers();
  });

  test('the refresh timer never keeps a process alive', () => {
    jest.useFakeTimers();
    const { hydrator } = build();
    const spy = jest.spyOn(global, 'setInterval');

    const stop = hydrator.startRefresh(['MAIL_KEY'], { intervalMs: 1000 });
    const timer = spy.mock.results[0].value;

    expect(typeof timer.unref).toBe('function');
    stop();
    spy.mockRestore();
    jest.useRealTimers();
  });
});
