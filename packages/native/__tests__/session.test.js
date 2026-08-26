const { createMemoryKeystore, createWebKeystore, createSecureSession } = require('../src');

function keystore() {
  return createMemoryKeystore();
}

describe('createSecureSession', () => {
  test('reads the access token from the keystore once, then from memory', async () => {
    const store = keystore();
    await store.setItemAsync('acme.auth.token', 'abc');
    const reads = jest.spyOn(store, 'getItemAsync');
    const session = createSecureSession({ keystore: store, namespace: 'acme' });

    expect(await session.getAccessToken()).toBe('abc');
    expect(await session.getAccessToken()).toBe('abc');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  test('save keeps both tokens and serves the access token from memory', async () => {
    const store = keystore();
    const session = createSecureSession({ keystore: store, namespace: 'acme' });

    await session.save({ accessToken: 'a1', refreshToken: 'r1' });

    expect(await store.getItemAsync('acme.auth.token')).toBe('a1');
    expect(await store.getItemAsync('acme.auth.refreshToken')).toBe('r1');
    expect(await session.getAccessToken()).toBe('a1');
    expect(await session.getRefreshToken()).toBe('r1');
  });

  test('save without a refresh token leaves the stored one alone', async () => {
    const store = keystore();
    const session = createSecureSession({ keystore: store, namespace: 'acme' });
    await session.save({ accessToken: 'a1', refreshToken: 'r1' });

    await session.save({ accessToken: 'a2' });

    expect(await session.getRefreshToken()).toBe('r1');
    expect(await session.getAccessToken()).toBe('a2');
  });

  test('clear wipes both tokens AND the biometric flag', async () => {
    const store = keystore();
    const session = createSecureSession({ keystore: store, namespace: 'acme' });
    await session.save({ accessToken: 'a1', refreshToken: 'r1' });
    await store.setItemAsync('acme.biometric.enabled', 'true');

    await session.clear();

    expect(await store.getItemAsync('acme.auth.token')).toBeNull();
    expect(await store.getItemAsync('acme.auth.refreshToken')).toBeNull();
    expect(await store.getItemAsync('acme.biometric.enabled')).toBeNull();
    expect(await session.getAccessToken()).toBeNull();
  });

  test('a keystore that throws on read does not take the app down', async () => {
    const store = {
      getItemAsync: async () => { throw new Error('Keychain locked'); },
      setItemAsync: async () => {},
      deleteItemAsync: async () => {}
    };
    const session = createSecureSession({ keystore: store, namespace: 'acme' });

    await expect(session.getAccessToken()).resolves.toBeNull();
  });

  test('namespacing keeps two apps on one device apart', async () => {
    const store = keystore();
    const one = createSecureSession({ keystore: store, namespace: 'acme' });
    const two = createSecureSession({ keystore: store, namespace: 'globex' });

    await one.save({ accessToken: 'a', refreshToken: 'ra' });
    await two.save({ accessToken: 'b', refreshToken: 'rb' });

    expect(await one.getAccessToken()).toBe('a');
    expect(await two.getAccessToken()).toBe('b');
  });

  test('requires a keystore', () => {
    expect(() => createSecureSession({})).toThrow(/keystore/i);
  });
});

describe('createWebKeystore', () => {
  test('mirrors the keystore contract over a storage object', async () => {
    const backing = new Map();
    const web = createWebKeystore({
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, v),
      removeItem: (k) => backing.delete(k)
    });

    await web.setItemAsync('k', 'v');
    expect(await web.getItemAsync('k')).toBe('v');
    await web.deleteItemAsync('k');
    expect(await web.getItemAsync('k')).toBeNull();
  });

  test('with no storage at all it answers null instead of throwing', async () => {
    const web = createWebKeystore(null);
    await web.setItemAsync('k', 'v');
    expect(await web.getItemAsync('k')).toBeNull();
  });
});
