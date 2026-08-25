const { createFieldCipher, generateFieldEncryptionKey } = require('@astratra/security');
const {
  createCredentialCatalog,
  createCredentialVault,
  createMemoryCredentialStore,
  createValueGuard,
  DISCONNECTED
} = require('../src');

const catalog = createCredentialCatalog({
  spaces: [
    {
      id: 'ai',
      label: 'AI',
      keys: [
        { key: 'GROQ_API_KEY', label: 'Groq' },
        { key: 'PUBLIC_CLIENT_ID', label: 'Client id', secret: false }
      ]
    },
    { id: 'pay', label: 'Payments', keys: [{ key: 'SECRET_KEY', label: 'Secret key' }] }
  ],
  reservedKeys: ['ENCRYPTION_KEY']
});

function build(overrides = {}) {
  const cipher = overrides.cipher || createFieldCipher({ key: generateFieldEncryptionKey() });
  const store = overrides.store || createMemoryCredentialStore();
  const env = overrides.env || {};
  const vault = createCredentialVault({ store, catalog, cipher, env, ...overrides });
  return { vault, store, cipher, env };
}

describe('credential vault', () => {
  test('a stored value wins over the environment', async () => {
    const { vault } = build({ env: { GROQ_API_KEY: 'from-env' } });

    await vault.set('GROQ_API_KEY', 'from-interface');

    expect(await vault.get('GROQ_API_KEY')).toBe('from-interface');
  });

  test('with nothing stored, the environment still serves', async () => {
    const { vault } = build({ env: { GROQ_API_KEY: 'from-env' } });

    expect(await vault.get('GROQ_API_KEY')).toBe('from-env');
  });

  test('a disconnected key returns null and the environment does NOT take over', async () => {
    const { vault } = build({ env: { GROQ_API_KEY: 'from-env' } });

    await vault.disconnect('GROQ_API_KEY');

    expect(await vault.get('GROQ_API_KEY')).toBeNull();
  });

  test('a secret is encrypted at rest, never stored in the clear', async () => {
    const { vault, store } = build();

    await vault.set('GROQ_API_KEY', 'gsk-super-secret');

    const [row] = await store.findAll();
    expect(row.value).not.toContain('gsk-super-secret');
    expect(row.secret).toBe(true);
  });

  test('a value declared not-secret is stored as-is, so it can be read back', async () => {
    const { vault, store } = build();

    await vault.set('PUBLIC_CLIENT_ID', 'ca_public_123');

    const [row] = await store.findAll();
    expect(row.value).toBe('ca_public_123');
    expect(row.secret).toBe(false);
  });

  test('one unreadable row does not take the others down', async () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const store = createMemoryCredentialStore([
      { key: 'GROQ_API_KEY', value: 'not-a-valid-payload', secret: true },
      { key: 'SECRET_KEY', value: cipher.encrypt('sk_test_ok'), secret: true }
    ]);
    const errors = [];
    const { vault } = build({ store, cipher, logger: { warn() {}, error: (m) => errors.push(m) } });

    expect(await vault.get('SECRET_KEY')).toBe('sk_test_ok');
    expect(errors).toHaveLength(1);
  });

  test('an unreadable key falls back to the environment instead of failing', async () => {
    const store = createMemoryCredentialStore([{ key: 'GROQ_API_KEY', value: 'garbage', secret: true }]);
    const { vault } = build({ store, env: { GROQ_API_KEY: 'from-env' } });

    expect(await vault.get('GROQ_API_KEY')).toBe('from-env');
  });

  test('a store that throws never breaks a read', async () => {
    const store = { async findAll() { throw new Error('database hiccup'); }, async upsert() {} };
    const { vault } = build({ store, env: { GROQ_API_KEY: 'from-env' } });

    await expect(vault.get('GROQ_API_KEY')).resolves.toBe('from-env');
  });

  test('getMany answers several keys from one read', async () => {
    const { vault, store } = build({ env: { SECRET_KEY: 'sk_test_env' } });
    await vault.set('GROQ_API_KEY', 'gsk-1');
    let reads = 0;
    const counted = { ...store, findAll: async (...args) => { reads += 1; return store.findAll(...args); } };
    const counting = createCredentialVault({
      store: counted, catalog, cipher: build().cipher, env: {}
    });
    await counting.getMany(['GROQ_API_KEY', 'SECRET_KEY']);

    expect(reads).toBe(1);
    expect(await vault.getMany(['GROQ_API_KEY', 'SECRET_KEY']))
      .toEqual({ GROQ_API_KEY: 'gsk-1', SECRET_KEY: 'sk_test_env' });
  });

  test('stored() keeps the distinction get() erases', async () => {
    const { vault } = build({ env: { SECRET_KEY: 'sk_test_env' } });
    await vault.disconnect('GROQ_API_KEY');

    const stored = await vault.stored();

    expect(stored.get('GROQ_API_KEY')).toBeNull();   // present, unplugged
    expect(stored.has('SECRET_KEY')).toBe(false);    // absent entirely
  });

  test('an unknown key cannot be written: the catalogue is the whole point', async () => {
    const { vault } = build();

    await expect(vault.set('ANYTHING_ELSE', 'x')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a reserved key cannot be written: the lock does not go inside the safe', async () => {
    const { vault } = build();

    await expect(vault.set('ENCRYPTION_KEY', 'x')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('an empty value is refused rather than stored as nothing', async () => {
    const { vault } = build();

    await expect(vault.set('GROQ_API_KEY', '   ')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('the guard refuses a live value from outside production', async () => {
    const guard = createValueGuard({
      keys: ['SECRET_KEY'],
      decidingKey: 'SECRET_KEY',
      livePattern: /^sk_live_/,
      isProduction: () => false
    });
    const { vault } = build({ guard });

    await expect(vault.set('SECRET_KEY', 'sk_live_abc')).rejects.toMatchObject({ statusCode: 403 });
    await expect(vault.set('SECRET_KEY', 'sk_test_abc')).resolves.toBeUndefined();
  });

  test('a live value already stored is not readable outside production', async () => {
    const guard = createValueGuard({
      keys: ['SECRET_KEY'],
      decidingKey: 'SECRET_KEY',
      livePattern: /^sk_live_/,
      isProduction: () => false
    });
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const store = createMemoryCredentialStore([
      { key: 'SECRET_KEY', value: cipher.encrypt('sk_live_real'), secret: true }
    ]);
    const { vault } = build({ store, cipher, guard, env: { SECRET_KEY: 'sk_test_local' } });

    expect(await vault.get('SECRET_KEY')).toBe('sk_test_local');
  });

  test('reads are cached, and a write makes the new value serve immediately', async () => {
    let reads = 0;
    const memory = createMemoryCredentialStore();
    const store = {
      findAll: async () => { reads += 1; return memory.findAll(); },
      upsert: (row) => memory.upsert(row)
    };
    const { vault } = build({ store });

    await vault.get('GROQ_API_KEY');
    await vault.get('GROQ_API_KEY');
    expect(reads).toBe(1);

    await vault.set('GROQ_API_KEY', 'fresh');
    expect(await vault.get('GROQ_API_KEY')).toBe('fresh');
  });

  test('forget() drops the cache', async () => {
    let reads = 0;
    const memory = createMemoryCredentialStore();
    const store = {
      findAll: async () => { reads += 1; return memory.findAll(); },
      upsert: (row) => memory.upsert(row)
    };
    const { vault } = build({ store });

    await vault.get('GROQ_API_KEY');
    vault.forget();
    await vault.get('GROQ_API_KEY');

    expect(reads).toBe(2);
  });

  test('onChange fires after a write, so the environment can be re-hydrated', async () => {
    const seen = [];
    const { vault } = build({ onChange: (event) => seen.push(event) });

    await vault.set('GROQ_API_KEY', 'x');
    await vault.disconnect('GROQ_API_KEY');

    expect(seen).toEqual([
      { key: 'GROQ_API_KEY', action: 'set' },
      { key: 'GROQ_API_KEY', action: 'disconnect' }
    ]);
  });

  test('the disconnect marker is what lands in the store', async () => {
    const { vault, store } = build();

    await vault.disconnect('GROQ_API_KEY');

    const [row] = await store.findAll();
    expect(row.value).toBe(DISCONNECTED);
  });
});

describe('credential vault status', () => {
  test('never returns a secret, only enough to recognise it', async () => {
    const { vault } = build();
    await vault.set('GROQ_API_KEY', 'gsk-abcdefgh1234');

    const { spaces } = await vault.status();
    const entry = spaces[0].keys.find((key) => key.key === 'GROQ_API_KEY');

    expect(entry.preview).toBe('••••1234');
    expect(JSON.stringify(spaces)).not.toContain('gsk-abcdefgh1234');
  });

  test('shows a non-secret value in full: it exists to be checked at a glance', async () => {
    const { vault } = build();
    await vault.set('PUBLIC_CLIENT_ID', 'ca_public_123');

    const { spaces } = await vault.status();
    const entry = spaces[0].keys.find((key) => key.key === 'PUBLIC_CLIENT_ID');

    expect(entry.preview).toBe('ca_public_123');
  });

  test('names where the value in use comes from', async () => {
    const { vault } = build({ env: { SECRET_KEY: 'sk_test_env' } });
    await vault.set('GROQ_API_KEY', 'gsk-1');
    await vault.disconnect('PUBLIC_CLIENT_ID');

    const { spaces } = await vault.status();
    const byKey = Object.fromEntries(spaces.flatMap((s) => s.keys).map((k) => [k.key, k]));

    expect(byKey.GROQ_API_KEY.source).toBe('interface');
    expect(byKey.SECRET_KEY.source).toBe('environment');
    expect(byKey.PUBLIC_CLIENT_ID.source).toBe('disconnected');
    expect(byKey.PUBLIC_CLIENT_ID.configured).toBe(false);
  });

  test('announces a key this machine may not hold before anything is typed', async () => {
    const guard = createValueGuard({
      keys: ['SECRET_KEY'],
      livePattern: /^sk_live_/,
      isProduction: () => false
    });
    const { vault } = build({ guard });

    const { spaces } = await vault.status();
    const byKey = Object.fromEntries(spaces.flatMap((s) => s.keys).map((k) => [k.key, k]));

    expect(byKey.SECRET_KEY.readOnly).toBe(true);
    expect(byKey.SECRET_KEY.readOnlyReason).toMatch(/production/i);
    expect(byKey.GROQ_API_KEY.readOnly).toBe(false);
  });
});
