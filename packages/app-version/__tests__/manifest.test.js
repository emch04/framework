const { createVersionHandler, defineVersionManifest, toExpressHandler } = require('../src');

const PLAY = 'https://play.google.com/store/apps/details?id=com.acme';

describe('defineVersionManifest', () => {
  test('normalises a valid manifest and freezes it', () => {
    const manifest = defineVersionManifest({
      ios: { latest: '1.1.4', minimum: '1.0.0', storeUrl: null },
      android: { latest: ' 1.1.4 ', storeUrl: PLAY }
    });
    expect(manifest).toEqual({
      ios: { latest: '1.1.4', minimum: '1.0.0', storeUrl: null },
      android: { latest: '1.1.4', minimum: null, storeUrl: PLAY }
    });
    expect(Object.isFrozen(manifest.android)).toBe(true);
  });

  test('a typo fails at boot instead of silencing every banner', () => {
    expect(() => defineVersionManifest({ android: { latest: '1.2.x', storeUrl: PLAY } })).toThrow(/latest/);
    expect(() => defineVersionManifest({ android: { latest: '1.2.0', minimum: 'one', storeUrl: PLAY } })).toThrow(/minimum/);
    expect(() => defineVersionManifest({ android: { latest: '1.2.0', minimum: '1.3.0', storeUrl: PLAY } })).toThrow(/above/);
    expect(() => defineVersionManifest({ android: { latest: '1.2.0', storeUrl: 'http://play.google.com' } })).toThrow(/storeUrl/);
    expect(() => defineVersionManifest({ web: { latest: '1.2.0' } })).toThrow(/platform/);
    expect(() => defineVersionManifest(null)).toThrow();
  });
});

describe('the public version route', () => {
  const manifest = defineVersionManifest({ android: { latest: '1.2.0', minimum: '1.0.0', storeUrl: PLAY } });

  test('answers without a session, cacheable for five minutes', () => {
    const response = createVersionHandler({ versions: manifest })();
    expect(response).toEqual({ status: 200, headers: { 'Cache-Control': 'public, max-age=300' }, body: manifest });
  });

  test('a function is read on every request', () => {
    let current = manifest;
    const handler = createVersionHandler({ versions: () => current, maxAgeSeconds: 60 });
    current = { changed: true };
    expect(handler()).toMatchObject({ headers: { 'Cache-Control': 'public, max-age=60' }, body: { changed: true } });
  });

  test('mounts on Express with the app envelope', () => {
    const headers = {};
    let sent = null;
    const res = {
      setHeader: (name, value) => { headers[name] = value; },
      status: (code) => ({ json: (body) => { sent = { code, body }; } })
    };
    toExpressHandler(createVersionHandler({ versions: manifest }), { wrap: (data) => ({ success: true, data }) })({}, res);
    expect(headers['Cache-Control']).toBe('public, max-age=300');
    expect(sent).toEqual({ code: 200, body: { success: true, data: manifest } });
  });

  test('refuses a missing manifest or a bad max-age', () => {
    expect(() => createVersionHandler({})).toThrow(/versions/);
    expect(() => createVersionHandler({ versions: manifest, maxAgeSeconds: -1 })).toThrow(/maxAgeSeconds/);
  });
});
