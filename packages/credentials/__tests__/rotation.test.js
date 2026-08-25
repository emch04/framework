const { createFieldCipher, generateFieldEncryptionKey } = require('@astratra/security');
const {
  createCredentialCatalog,
  createCredentialRotation,
  createCredentialVault,
  createMemoryCredentialStore,
  DISCONNECTED
} = require('../src');

const catalog = createCredentialCatalog({
  spaces: [{
    id: 'all',
    label: 'All',
    keys: [
      { key: 'GROQ_API_KEY', label: 'Groq' },
      { key: 'MAIL_API_KEY', label: 'Mail' },
      { key: 'PUBLIC_CLIENT_ID', label: 'Client id', secret: false }
    ]
  }]
});

const OLD = createFieldCipher({ key: generateFieldEncryptionKey() });
const NEW = createFieldCipher({ key: generateFieldEncryptionKey() });
const STRANGER = createFieldCipher({ key: generateFieldEncryptionKey() });

const build = (rows = []) => {
  const store = createMemoryCredentialStore(rows);
  return { store, rotation: createCredentialRotation({ store, catalog, from: OLD, to: NEW }) };
};

const row = (key, cipher, value, secret = true) => ({ key, value: cipher ? cipher.encrypt(value) : value, secret });

describe('credential rotation', () => {
  test('plan() writes nothing and says what it would do', async () => {
    const { store, rotation } = build([row('GROQ_API_KEY', OLD, 'gsk-1')]);
    const before = (await store.findAll())[0].value;

    const report = await rotation.plan();

    expect(report).toMatchObject({ apply: false, scanned: 1, rotated: 1, written: 0 });
    expect((await store.findAll())[0].value).toBe(before);
  });

  test('apply() rewrites the value so the new cipher reads it', async () => {
    const { store, rotation } = build([row('GROQ_API_KEY', OLD, 'gsk-1')]);

    const report = await rotation.apply();

    expect(report).toMatchObject({ rotated: 1, written: 1 });
    expect(NEW.decrypt((await store.findAll())[0].value)).toBe('gsk-1');
  });

  test('a value already migrated is recognised, not touched', async () => {
    const { store, rotation } = build([row('GROQ_API_KEY', NEW, 'gsk-1')]);
    const before = (await store.findAll())[0].value;

    const report = await rotation.apply();

    expect(report).toMatchObject({ already: 1, rotated: 0, written: 0 });
    expect((await store.findAll())[0].value).toBe(before);
  });

  test('running it twice is safe — the second pass finds nothing to do', async () => {
    const { rotation } = build([row('GROQ_API_KEY', OLD, 'gsk-1'), row('MAIL_API_KEY', OLD, 'mail-1')]);
    await rotation.apply();

    const second = await rotation.apply();

    expect(second).toMatchObject({ rotated: 0, already: 2, written: 0 });
  });

  test('an interrupted run is simply re-run: the migrated half is skipped', async () => {
    const { store, rotation } = build([
      row('GROQ_API_KEY', NEW, 'gsk-1'),   // migrated before the interruption
      row('MAIL_API_KEY', OLD, 'mail-1')   // still pending
    ]);

    const report = await rotation.apply();

    expect(report).toMatchObject({ already: 1, rotated: 1, written: 1 });
    for (const stored of await store.findAll()) {
      expect(() => NEW.decrypt(stored.value)).not.toThrow();
    }
  });

  test('a value neither cipher reads is reported and NEVER overwritten', async () => {
    const lost = row('GROQ_API_KEY', STRANGER, 'gone');
    const { store, rotation } = build([lost]);

    const report = await rotation.apply();

    expect(report).toMatchObject({ unreadable: 1, rotated: 0, written: 0 });
    expect(report.unreadableKeys).toEqual(['GROQ_API_KEY']);
    expect((await store.findAll())[0].value).toBe(lost.value);
  });

  test('a disconnect marker survives: unplugged must not become unreadable', async () => {
    const { store, rotation } = build([{ key: 'GROQ_API_KEY', value: DISCONNECTED, secret: true }]);

    const report = await rotation.apply();

    expect(report).toMatchObject({ skipped: 1, written: 0 });
    expect((await store.findAll())[0].value).toBe(DISCONNECTED);
  });

  test('a value stored in the clear on purpose is left in the clear', async () => {
    const { store, rotation } = build([row('PUBLIC_CLIENT_ID', null, 'ca_public_123', false)]);

    const report = await rotation.apply();

    expect(report).toMatchObject({ plain: 1, written: 0 });
    expect((await store.findAll())[0].value).toBe('ca_public_123');
  });

  test('isComplete() refuses to green-light while anything is pending', async () => {
    const { rotation } = build([row('GROQ_API_KEY', OLD, 'gsk-1')]);

    expect(await rotation.isComplete()).toMatchObject({ complete: false, pending: 1 });
  });

  test('isComplete() refuses to green-light while anything is unreadable', async () => {
    const { rotation } = build([row('GROQ_API_KEY', STRANGER, 'gone')]);
    await rotation.apply();

    expect(await rotation.isComplete()).toMatchObject({
      complete: false, pending: 0, unreadable: 1, unreadableKeys: ['GROQ_API_KEY']
    });
  });

  test('isComplete() green-lights only once everything reads with the new cipher', async () => {
    const { rotation } = build([row('GROQ_API_KEY', OLD, 'gsk-1'), row('MAIL_API_KEY', OLD, 'mail-1')]);
    await rotation.apply();

    expect(await rotation.isComplete()).toMatchObject({ complete: true, pending: 0, unreadable: 0 });
  });

  test('wiring without both ciphers is refused up front', () => {
    const store = createMemoryCredentialStore();

    expect(() => createCredentialRotation({ store, catalog, to: NEW })).toThrow(/options\.from/);
    expect(() => createCredentialRotation({ store, catalog, from: OLD })).toThrow(/options\.to/);
  });
});

describe('the vault during a rotation', () => {
  const vaultWith = (rows, previousCipher) => createCredentialVault({
    store: createMemoryCredentialStore(rows),
    catalog,
    cipher: NEW,
    previousCipher,
    env: {},
    cacheMs: 0
  });

  test('a not-yet-migrated key stays readable while both ciphers are present', async () => {
    const vault = vaultWith([row('GROQ_API_KEY', OLD, 'gsk-1')], OLD);

    expect(await vault.get('GROQ_API_KEY')).toBe('gsk-1');
    expect(vault.isRotating()).toBe(true);
  });

  test('dropping the retiring cipher too early loses the key SILENTLY', async () => {
    const vault = vaultWith([row('GROQ_API_KEY', OLD, 'gsk-1')], null);

    /* No error, no warning: the value simply stops being used and the
       environment takes over. This is the whole reason isComplete() exists. */
    expect(await vault.get('GROQ_API_KEY')).toBeNull();
    expect(vault.isRotating()).toBe(false);
  });

  test('a migrated key is read with the new cipher, no fallback needed', async () => {
    const vault = vaultWith([row('GROQ_API_KEY', NEW, 'gsk-1')], null);

    expect(await vault.get('GROQ_API_KEY')).toBe('gsk-1');
  });

  test('writes during a rotation use the NEW cipher — that is what makes it converge', async () => {
    const store = createMemoryCredentialStore([row('GROQ_API_KEY', OLD, 'gsk-1')]);
    const vault = createCredentialVault({ store, catalog, cipher: NEW, previousCipher: OLD, env: {}, cacheMs: 0 });

    await vault.set('GROQ_API_KEY', 'gsk-2');

    expect(NEW.decrypt((await store.findAll())[0].value)).toBe('gsk-2');
  });

  test('the status screen still shows a not-yet-migrated key correctly', async () => {
    const vault = vaultWith([row('GROQ_API_KEY', OLD, 'gsk-abcdefgh1234')], OLD);

    const { spaces } = await vault.status();
    const entry = spaces[0].keys.find((key) => key.key === 'GROQ_API_KEY');

    expect(entry).toMatchObject({ configured: true, source: 'interface', preview: '••••1234' });
  });

  test('a previousCipher without decrypt() is refused up front', () => {
    expect(() => createCredentialVault({
      store: createMemoryCredentialStore(), catalog, cipher: NEW, previousCipher: {}
    })).toThrow(/previousCipher/);
  });
});
