/**
 * The client side: three promises — versions compare as numbers, a phone is
 * never blocked without a store link, and a dismissed banner only comes back
 * for a newer version. Ported from the app that shipped it (19/09/2026).
 */
const {
  STORE_CHECK_INTERVAL_MS,
  createStoreVersionWatcher,
  infoForPlatform,
  isBannerVisible,
  readStoreCopy,
  shouldCheckStore,
  versionStatus
} = require('../src');

const PLAY = 'https://play.google.com/store/apps/details?id=com.acme';
const info = (latest, minimum = '1.0.0', storeUrl = PLAY) => ({ latest, minimum, storeUrl });

describe('versionStatus', () => {
  test('the four states', () => {
    expect(versionStatus('1.1.4', info('1.1.4'))).toBe('up_to_date');
    /* Newer than the published one (a test build): up to date. */
    expect(versionStatus('1.2.0', info('1.1.4'))).toBe('up_to_date');
    expect(versionStatus('1.1.3', info('1.1.4'))).toBe('available');
    expect(versionStatus('1.9.3', info('1.10.0'))).toBe('available');
    expect(versionStatus('0.9.0', info('1.1.4'))).toBe('required');
    expect(versionStatus('1.1.3', info('1.1.4', '1.1.4'))).toBe('required');
    /* Exactly the minimum: still accepted. */
    expect(versionStatus('1.0.0', info('1.1.4', '1.0.0'))).toBe('available');
  });

  test('no store link: neither banner nor block', () => {
    expect(versionStatus('0.9.0', info('1.1.4', '1.0.0', null))).toBe('unknown');
    expect(versionStatus('1.1.3', info('1.1.4', '1.0.0', ''))).toBe('unknown');
    expect(versionStatus('1.1.3', info('1.1.4', '1.0.0', 'http://play.google.com'))).toBe('unknown');
    expect(versionStatus('1.1.3', info('1.1.4', '1.0.0', 'javascript:alert(1)'))).toBe('unknown');
  });

  test('"unknown" for an unreadable version or a missing answer; a bad minimum blocks nobody', () => {
    expect(versionStatus(null, info('1.1.4'))).toBe('unknown');
    expect(versionStatus('dev', info('1.1.4'))).toBe('unknown');
    expect(versionStatus('1.1.3', info('n/a'))).toBe('unknown');
    expect(versionStatus('1.1.3', null)).toBe('unknown');
    expect(versionStatus('0.1.0', info('1.1.4', '???'))).toBe('available');
    expect(versionStatus('0.1.0', info('1.1.4', null))).toBe('available');
  });
});

describe('isBannerVisible', () => {
  test('dismissed for one version, back for the next', () => {
    expect(isBannerVisible('available', '1.1.4', null)).toBe(true);
    expect(isBannerVisible('available', '1.1.4', '1.1.4')).toBe(false);
    expect(isBannerVisible('available', '1.1.5', '1.1.4')).toBe(true);
    expect(isBannerVisible('available', '1.10.0', '1.9.0')).toBe(true);
    /* Dismissed for a version newer than the one announced (server rolled back): stays closed. */
    expect(isBannerVisible('available', '1.1.4', '1.1.5')).toBe(false);
    /* An unreadable trace does not silence it. */
    expect(isBannerVisible('available', '1.1.4', 'whatever')).toBe(true);
    /* Only for "available": a block cannot be dismissed. */
    for (const status of ['up_to_date', 'required', 'unknown']) expect(isBannerVisible(status, '1.1.4', null)).toBe(false);
  });
});

describe('shouldCheckStore', () => {
  test('at most every six hours, never offline', () => {
    const now = 10 * STORE_CHECK_INTERVAL_MS;
    expect(STORE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(shouldCheckStore({ lastCheck: null, now, online: true })).toBe(true);
    expect(shouldCheckStore({ lastCheck: null, now, online: false })).toBe(false);
    expect(shouldCheckStore({ lastCheck: now - STORE_CHECK_INTERVAL_MS + 1, now, online: true })).toBe(false);
    expect(shouldCheckStore({ lastCheck: now - STORE_CHECK_INTERVAL_MS, now, online: true })).toBe(true);
    /* The screen opened from the push forces it — but not offline. */
    expect(shouldCheckStore({ lastCheck: now, now, online: true, force: true })).toBe(true);
    expect(shouldCheckStore({ lastCheck: 0, now, online: false, force: true })).toBe(false);
    /* Clock set backwards. */
    expect(shouldCheckStore({ lastCheck: now + 1000, now, online: true })).toBe(true);
  });
});

describe('infoForPlatform and readStoreCopy', () => {
  test('the answer is read platform by platform', () => {
    const data = {
      ios: { latest: '1.1.4', minimum: '1.0.0', storeUrl: null },
      android: { latest: ' 1.1.4 ', minimum: '1.0.0', storeUrl: PLAY }
    };
    expect(infoForPlatform(data, 'android')).toEqual({ latest: '1.1.4', minimum: '1.0.0', storeUrl: PLAY });
    expect(infoForPlatform(data, 'ios')).toEqual({ latest: '1.1.4', minimum: '1.0.0', storeUrl: null });
    expect(infoForPlatform(data, 'web')).toBeNull();
    expect(infoForPlatform(null, 'ios')).toBeNull();
    expect(infoForPlatform({ ios: { latest: '?' } }, 'ios')).toBeNull();
    expect(infoForPlatform({ android: { latest: '2.0.0', minimum: 3, storeUrl: 'ftp://x' } }, 'android'))
      .toEqual({ latest: '2.0.0', minimum: null, storeUrl: null });
  });

  test('a damaged disk copy is "nothing"', () => {
    expect(readStoreCopy(JSON.stringify({ data: { a: 1 }, receivedAt: 5 }))).toEqual({ data: { a: 1 }, receivedAt: 5 });
    for (const damaged of [null, '', '{', 'null', JSON.stringify({ data: {} }), JSON.stringify({ receivedAt: 'x' })]) {
      expect(readStoreCopy(damaged)).toBeNull();
    }
  });
});

describe('createStoreVersionWatcher', () => {
  const ANSWER = { android: { latest: '1.2.0', minimum: '1.0.0', storeUrl: PLAY } };

  function harness(overrides = {}) {
    const disk = new Map(overrides.disk || []);
    const calls = { fetch: 0 };
    let clock = overrides.clock ?? 1_000_000;
    let online = overrides.online ?? true;
    let foreground = null;
    const watcher = createStoreVersionWatcher({
      fetchVersions: overrides.fetchVersions || (async () => { calls.fetch += 1; return ANSWER; }),
      storage: overrides.storage || {
        getItem: async (key) => disk.get(key) ?? null,
        setItem: async (key, value) => { disk.set(key, value); }
      },
      installedVersion: () => overrides.installed ?? '1.1.0',
      platform: 'android',
      isOnline: () => online,
      now: () => clock,
      namespace: 'acme',
      onForeground: (listener) => { foreground = listener; return { remove: () => { foreground = null; } }; }
    });
    return {
      watcher,
      disk,
      calls,
      advance: (ms) => { clock += ms; },
      setOnline: (value) => { online = value; },
      foreground: () => foreground && foreground()
    };
  }

  test('start asks the network, publishes, and keeps a copy on disk', async () => {
    const h = harness();
    const seen = [];
    h.watcher.subscribe(() => seen.push(h.watcher.getSnapshot().status));
    await h.watcher.start();
    expect(h.watcher.getSnapshot()).toEqual({ status: 'available', installed: '1.1.0', info: { latest: '1.2.0', minimum: '1.0.0', storeUrl: PLAY }, banner: true });
    expect(seen).toContain('available');
    expect(readStoreCopy(h.disk.get('acme.storeVersion.copy'))).toEqual({ data: ANSWER, receivedAt: 1_000_000 });
  });

  test('at most one check every six hours, across foreground returns', async () => {
    const h = harness();
    await h.watcher.start();
    h.foreground();
    await h.watcher.check();
    expect(h.calls.fetch).toBe(1);
    h.advance(STORE_CHECK_INTERVAL_MS);
    h.foreground();
    await h.watcher.check();
    expect(h.calls.fetch).toBe(2);
  });

  test('the six hours count from the last answer on disk, across launches', async () => {
    const copy = JSON.stringify({ data: ANSWER, receivedAt: 1_000_000 - 1000 });
    const h = harness({ disk: [['acme.storeVersion.copy', copy]] });
    await h.watcher.start();
    expect(h.calls.fetch).toBe(0);
    expect(h.watcher.getSnapshot().status).toBe('available');
  });

  test('offline: silence, and the last known answer stays', async () => {
    const copy = JSON.stringify({ data: ANSWER, receivedAt: 0 });
    const h = harness({ disk: [['acme.storeVersion.copy', copy]], online: false });
    await h.watcher.start();
    expect(h.calls.fetch).toBe(0);
    expect(h.watcher.getSnapshot().banner).toBe(true);
  });

  test('a failing request never throws and keeps what was known', async () => {
    const h = harness({ fetchVersions: async () => { throw new Error('offline'); } });
    await expect(h.watcher.start()).resolves.toBeUndefined();
    expect(h.watcher.getSnapshot().status).toBe('unknown');
  });

  test('concurrent checks share one request', async () => {
    const h = harness();
    await Promise.all([h.watcher.check(), h.watcher.check(), h.watcher.check({ force: true })]);
    expect(h.calls.fetch).toBe(1);
  });

  test('force asks again inside the six hours', async () => {
    const h = harness();
    await h.watcher.start();
    await h.watcher.check({ force: true });
    expect(h.calls.fetch).toBe(2);
  });

  test('dismiss hides the banner for THIS version, persisted, and a newer one brings it back', async () => {
    let answer = ANSWER;
    const h = harness({ fetchVersions: async () => answer });
    await h.watcher.start();
    await h.watcher.dismiss('1.2.0');
    expect(h.watcher.getSnapshot().banner).toBe(false);
    expect(h.disk.get('acme.storeVersion.dismissed')).toBe('1.2.0');

    answer = { android: { ...ANSWER.android, latest: '1.3.0' } };
    await h.watcher.check({ force: true });
    expect(h.watcher.getSnapshot().banner).toBe(true);
  });

  test('the dismissed version is read back at launch', async () => {
    const h = harness({ disk: [['acme.storeVersion.dismissed', '1.2.0']] });
    await h.watcher.start();
    expect(h.watcher.getSnapshot()).toMatchObject({ status: 'available', banner: false });
  });

  test('an unreadable disk is a first launch, not a crash', async () => {
    const storage = { getItem: async () => { throw new Error('io'); }, setItem: async () => { throw new Error('io'); } };
    const h = harness({ storage });
    await h.watcher.start();
    expect(h.calls.fetch).toBe(1);
    await expect(h.watcher.dismiss('1.2.0')).resolves.toBeUndefined();
    expect(h.watcher.getSnapshot().banner).toBe(false);
  });

  test('the snapshot object is stable between changes (useSyncExternalStore)', async () => {
    const h = harness();
    await h.watcher.start();
    expect(h.watcher.getSnapshot()).toBe(h.watcher.getSnapshot());
  });

  test('stop removes the foreground listener; unsubscribe stops notifications', async () => {
    const h = harness();
    const listener = jest.fn();
    const unsubscribe = h.watcher.subscribe(listener);
    await h.watcher.start();
    unsubscribe();
    await h.watcher.dismiss('1.2.0');
    const count = listener.mock.calls.length;
    await h.watcher.dismiss('1.2.1');
    expect(listener.mock.calls.length).toBe(count);
    h.watcher.stop();
    h.advance(STORE_CHECK_INTERVAL_MS);
    h.foreground();
    expect(h.calls.fetch).toBe(1);
  });

  test('refuses to start without its adapters', () => {
    expect(() => createStoreVersionWatcher({})).toThrow(/fetchVersions/);
    expect(() => createStoreVersionWatcher({ fetchVersions: async () => ({}) })).toThrow(/storage/);
  });
});
