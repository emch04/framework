/**
 * Announcing a new version: once, in daytime, to behind phones only, in the
 * account's language — and only where the switch is on.
 * Ported from the app that shipped it (19/09/2026).
 */
const {
  createMemoryAnnouncementStore,
  createVersionAnnouncer,
  defineVersionManifest,
  isAnnouncementEnabled,
  isWithinDaytime,
  startAnnouncementSchedule
} = require('../src');

const DAY = new Date('2026-09-19T10:00:00Z');
const NIGHT = new Date('2026-09-19T23:00:00Z');
const PLAY = 'https://play.google.com/store/apps/details?id=com.acme';
const VERSIONS = defineVersionManifest({
  android: { latest: '1.2.0', minimum: '1.0.0', storeUrl: PLAY },
  ios: { latest: '1.2.0', minimum: '1.0.0', storeUrl: null }
});
const MESSAGES = {
  en: { title: 'New version of Acme', body: 'Version {version} is available.' },
  fr: { title: 'Nouvelle version d’Acme', body: ({ version }) => `La version ${version} est disponible.` }
};

const device = (n, appVersion, language) => ({ id: `d${n}`, appVersion, language, token: `t${n}` });

function harness(overrides = {}) {
  const store = overrides.store || createMemoryAnnouncementStore();
  const sends = [];
  const listed = [];
  const devices = overrides.devices || [device(1, '1.1.4', 'en'), device(2, '1.2.0', 'en'), device(3, undefined, 'fr')];
  const announcer = createVersionAnnouncer({
    versions: VERSIONS,
    store,
    listDevices: async (platform) => { listed.push(platform); return devices; },
    send: overrides.send || (async (targets, message) => { sends.push({ ids: targets.map((d) => d.id), message }); return { sent: targets.length, failed: 0 }; }),
    messages: MESSAGES,
    payload: { category: 'app_update', route: '/update' },
    enabled: true,
    now: () => overrides.now || DAY,
    ...overrides.options
  });
  return { announcer, store, sends, listed };
}

describe('announcing a new version', () => {
  test('behind phones only, in their language, with the caller payload', async () => {
    const { announcer, store, sends } = harness();
    const results = await announcer.run();

    const ids = sends.flatMap((s) => s.ids).sort();
    expect(ids).toEqual(['d1', 'd3']); // d2 is already on 1.2.0; d3 never reported a version
    const english = sends.find((s) => s.ids.includes('d1')).message;
    expect(english).toMatchObject({ title: 'New version of Acme', body: 'Version 1.2.0 is available.', category: 'app_update', route: '/update', language: 'en', version: '1.2.0', platform: 'android' });
    const french = sends.find((s) => s.ids.includes('d3')).message;
    expect(french.body).toBe('La version 1.2.0 est disponible.');
    expect(results).toEqual([{ platform: 'android', version: '1.2.0', sent: 2, failed: 0 }]);
    expect(await store.get('android:1.2.0')).toMatchObject({ sent: 2, failed: 0, finishedAt: DAY });
    /* iOS has no public store page: nothing claimed, nothing sent. */
    expect(await store.get('ios:1.2.0')).toBeNull();
  });

  test('announced once: a second run, or a second instance on the same store, sends nothing', async () => {
    const store = createMemoryAnnouncementStore();
    const first = harness({ store });
    await first.announcer.run();
    const second = harness({ store });
    expect(await second.announcer.run()).toEqual([]);
    expect(await first.announcer.run()).toEqual([]);
    expect(second.sends).toHaveLength(0);
    expect(second.listed).toHaveLength(0);
  });

  test('the claim is written BEFORE any device is listed or pushed', async () => {
    const order = [];
    const inner = createMemoryAnnouncementStore();
    const store = {
      claim: async (c) => { order.push(`claim:${c.id}`); return inner.claim(c); },
      complete: async (id, o) => { order.push(`complete:${id}`); return inner.complete(id, o); }
    };
    const announcer = createVersionAnnouncer({
      versions: VERSIONS,
      store,
      listDevices: async () => { order.push('list'); return [device(1, '1.0.0', 'en')]; },
      send: async () => { order.push('send'); return { sent: 1, failed: 0 }; },
      messages: MESSAGES,
      enabled: true,
      now: () => DAY
    });
    await announcer.run();
    expect(order).toEqual(['claim:android:1.2.0', 'list', 'send', 'complete:android:1.2.0']);
  });

  test('a store error on claim propagates instead of sending unclaimed', async () => {
    const store = { claim: async () => { throw new Error('db down'); }, complete: async () => {} };
    const { announcer, sends } = harness({ store });
    await expect(announcer.run()).rejects.toThrow('db down');
    expect(sends).toHaveLength(0);
  });

  test('at night, it waits', async () => {
    const { announcer, sends, store } = harness({ now: NIGHT });
    expect(await announcer.run()).toEqual([]);
    expect(sends).toHaveLength(0);
    expect(await store.get('android:1.2.0')).toBeNull();
  });

  test('the daytime window edges: 07:00 in, 20:00 out', () => {
    expect(isWithinDaytime(new Date('2026-09-19T06:59:59Z'))).toBe(false);
    expect(isWithinDaytime(new Date('2026-09-19T07:00:00Z'))).toBe(true);
    expect(isWithinDaytime(new Date('2026-09-19T19:59:59Z'))).toBe(true);
    expect(isWithinDaytime(new Date('2026-09-19T20:00:00Z'))).toBe(false);
  });

  test('batches by size and by language', async () => {
    const devices = Array.from({ length: 5 }, (_, i) => device(i, '1.0.0', i % 2 ? 'fr' : 'en'));
    const { announcer, sends } = harness({ devices, options: { batchSize: 2 } });
    await announcer.run();
    /* Batches [0,1] [2,3] [4]: each split by language. */
    expect(sends.map((s) => s.ids)).toEqual([['d0'], ['d1'], ['d2'], ['d3'], ['d4']]);
  });

  test('the account language comes from languagesFor, then the device, then the default', async () => {
    const devices = [device(1, '1.0.0', null), device(2, '1.0.0', 'fr'), device(3, '1.0.0', null)];
    const { announcer, sends } = harness({ devices, options: { languagesFor: async () => ({ d1: 'fr' }) } });
    await announcer.run();
    const byLanguage = Object.fromEntries(sends.map((s) => [s.message.language, s.ids]));
    expect(byLanguage).toEqual({ fr: ['d1', 'd2'], en: ['d3'] });
  });

  test('an unknown language falls back to the default catalog entry', async () => {
    const { announcer, sends } = harness({ devices: [device(1, '1.0.0', 'sw')] });
    await announcer.run();
    expect(sends[0].message.title).toBe('New version of Acme');
  });

  test('a translate() function replaces the catalog', async () => {
    const translate = (language, { version }) => (language === 'en' ? { title: 'T', body: `v${version}` } : null);
    const { announcer, sends } = harness({ devices: [device(1, '1.0.0', 'de')], options: { messages: undefined, translate } });
    await announcer.run();
    expect(sends[0].message).toMatchObject({ title: 'T', body: 'v1.2.0' });
  });

  test('a failing batch is counted and the rest still goes out', async () => {
    let calls = 0;
    const send = async (targets) => { calls += 1; if (calls === 1) throw new Error('push down'); return { sent: targets.length, failed: 0 }; };
    const devices = [device(1, '1.0.0', 'en'), device(2, '1.0.0', 'en')];
    const { announcer, store } = harness({ devices, send, options: { batchSize: 1 } });
    expect(await announcer.run()).toEqual([{ platform: 'android', version: '1.2.0', sent: 1, failed: 1 }]);
    expect(await store.get('android:1.2.0')).toMatchObject({ sent: 1, failed: 1 });
  });

  test('no store page, or an unreadable latest, announces nothing', async () => {
    for (const versions of [{ android: { latest: '1.2.0', storeUrl: null } }, { android: { latest: 'soon', storeUrl: PLAY } }, { android: { latest: '1.2.0', storeUrl: 'http://evil.test' } }]) {
      const { announcer, sends } = harness({ options: { versions } });
      expect(await announcer.run()).toEqual([]);
      expect(sends).toHaveLength(0);
    }
  });

  test('no text in the package: without messages or translate it refuses to start', () => {
    expect(() => harness({ options: { messages: undefined } })).toThrow(/translate|messages/);
    expect(() => harness({ options: { messages: { fr: MESSAGES.fr } } })).toThrow(/"en"/);
  });
});

describe('the switch: only the production server announces', () => {
  test('off by default', async () => {
    const store = createMemoryAnnouncementStore();
    const sends = [];
    const announcer = createVersionAnnouncer({
      versions: VERSIONS,
      store,
      listDevices: async () => [device(1, '1.0.0', 'en')],
      send: async (t) => { sends.push(t); return { sent: 1, failed: 0 }; },
      messages: MESSAGES,
      now: () => DAY
    });
    expect(await announcer.run()).toEqual([]);
    expect(sends).toHaveLength(0);
    /* Nothing claimed either: turning it on later still announces. */
    expect(await store.get('android:1.2.0')).toBeNull();
  });

  test('re-read on every run when given as a function', async () => {
    const env = {};
    const { announcer, sends } = harness({ options: { enabled: () => isAnnouncementEnabled(env) } });
    expect(await announcer.run()).toEqual([]);
    env.ANNOUNCE_VERSIONS = '1';
    expect(await announcer.run()).toHaveLength(1);
    expect(sends.length).toBeGreaterThan(0);
  });

  test('strictly "1": nothing else turns real pushes on', () => {
    expect(isAnnouncementEnabled({ ANNOUNCE_VERSIONS: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', 1]) {
      expect(isAnnouncementEnabled({ ANNOUNCE_VERSIONS: value })).toBe(false);
    }
    expect(isAnnouncementEnabled({ SHIP: '1' }, 'SHIP')).toBe(true);
    expect(isAnnouncementEnabled(null)).toBe(false);
  });

  test('enabled: "true" (a string) does not count as on', async () => {
    const { announcer, sends } = harness({ options: { enabled: 'true' } });
    expect(await announcer.run()).toEqual([]);
    expect(sends).toHaveLength(0);
  });
});

describe('the schedule', () => {
  function fakeTimers() {
    const timers = { handles: [], cleared: [] };
    timers.setInterval = (fn, ms) => { timers.handles.push({ fn, ms }); return timers.handles.length; };
    timers.clearInterval = (h) => { timers.cleared.push(h); };
    return timers;
  }

  test('ticks through the lock, swallows errors to onError, stops cleanly', async () => {
    const timers = fakeTimers();
    const locks = [];
    const errors = [];
    const announcer = { run: async () => { throw new Error('boom'); } };
    const schedule = startAnnouncementSchedule({
      announcer,
      intervalMs: 1000,
      lock: async (name, ttl, fn) => { locks.push([name, ttl]); return fn(); },
      onError: (e) => errors.push(e.message),
      timers
    });
    expect(timers.handles[0].ms).toBe(1000);
    await schedule.tick();
    expect(locks).toEqual([['app-version-announcement', 800]]);
    expect(errors).toEqual(['boom']);
    schedule.stop();
    expect(timers.cleared).toEqual([1]);
  });
});
