const { createPushService, createNotificationRouter, createMemoryKeystore } = require('../src');

const IOS_STATUS = { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 };

function harness(overrides = {}) {
  const calls = { registered: [], unregistered: [], navigated: [], channels: [], categories: [], actions: [] };
  let permission = overrides.permission || { status: 'granted', granted: true };
  const device = { registered: true, enabled: true, ...overrides.device };
  const listeners = {};

  const notifications = {
    AndroidImportance: { HIGH: 4 },
    IosAuthorizationStatus: IOS_STATUS,
    getPermissionsAsync: async () => permission,
    requestPermissionsAsync: async () => {
      permission = overrides.afterRequest || { status: 'granted', granted: true };
      return permission;
    },
    setNotificationChannelAsync: async (id, config) => { calls.channels.push([id, config.name]); },
    setNotificationCategoryAsync: async (id, actions) => { calls.categories.push([id, actions.length]); },
    getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[xyz]' }),
    setNotificationHandler: (handler) => { calls.handler = handler; },
    addNotificationReceivedListener: (fn) => { listeners.received = fn; return { remove: () => { listeners.received = null; } }; },
    addNotificationResponseReceivedListener: (fn) => { listeners.response = fn; return { remove: () => { listeners.response = null; } }; },
    addPushTokenListener: (fn) => { listeners.token = fn; return { remove: () => { listeners.token = null; } }; },
    getLastNotificationResponseAsync: async () => overrides.coldStart || null,
    clearLastNotificationResponseAsync: async () => { calls.cleared = true; },
    ...overrides.notifications
  };

  const keystore = overrides.keystore || createMemoryKeystore();
  const router = createNotificationRouter({
    fallback: '/notifications',
    routes: [{ pattern: /^\/orders\/[^/]+$/, allow: (role) => role === 'seller' }]
  });

  const service = createPushService({
    load: async () => ({
      platform: overrides.platform || 'ios',
      isDevice: overrides.isDevice !== false,
      deviceName: 'iPhone de Test',
      randomUUID: () => 'uuid-1',
      keystore,
      projectId: 'project-1',
      notifications,
      channels: [{ id: 'acme-orders', name: 'Orders' }],
      categories: [{ id: 'order', actions: [{ identifier: 'VIEW', buttonTitle: 'Voir', options: { opensAppToForeground: true } }] }],
      router,
      navigate: (route) => calls.navigated.push(route),
      onAction: overrides.onAction || (async () => false),
      api: {
        register: async (payload) => { calls.registered.push(payload); return device; },
        current: async () => device,
        unregister: async (id) => { calls.unregistered.push(id); return { removed: true }; }
      }
    }),
    namespace: 'acme'
  });

  return { service, calls, listeners, keystore, setPermission: (p) => { permission = p; } };
}

describe('installation id', () => {
  test('is created once and kept in the keystore', async () => {
    const { service, keystore } = harness();

    expect(await service.getInstallationId()).toBe('uuid-1');
    expect(await keystore.getItemAsync('acme.notifications.installationId')).toBe('uuid-1');
  });

  test('an existing id is reused, never regenerated', async () => {
    const keystore = createMemoryKeystore();
    await keystore.setItemAsync('acme.notifications.installationId', 'uuid-old');
    const { service } = harness({ keystore });

    expect(await service.getInstallationId()).toBe('uuid-old');
  });
});

describe('getState', () => {
  test('a simulator is unsupported, whatever the permission says', async () => {
    const { service } = harness({ isDevice: false });

    expect(await service.getState()).toBe('unsupported');
  });

  test('reports the permission when it is not granted', async () => {
    const denied = harness({ permission: { status: 'denied' } });
    const fresh = harness({ permission: { status: 'undetermined' } });

    expect(await denied.service.getState()).toBe('denied');
    expect(await fresh.service.getState()).toBe('undetermined');
  });

  test('iOS provisional authorization counts as granted', async () => {
    const { service } = harness({ permission: { status: 'denied', ios: { status: IOS_STATUS.PROVISIONAL } } });

    expect(await service.getState()).toBe('enabled');
  });

  test('granted but unregistered on the server reads disabled, not enabled', async () => {
    const { service } = harness({ device: { registered: true, enabled: false } });

    expect(await service.getState()).toBe('disabled');
  });

  test('a failure anywhere answers error instead of throwing', async () => {
    const { service } = harness({ notifications: { getPermissionsAsync: async () => { throw new Error('boom'); } } });

    expect(await service.getState()).toBe('error');
  });
});

describe('enable', () => {
  test('registers the device and reports enabled', async () => {
    const { service, calls } = harness();

    expect(await service.enable()).toBe('enabled');
    expect(calls.registered[0]).toMatchObject({
      installationId: 'uuid-1',
      pushToken: 'ExponentPushToken[xyz]',
      platform: 'ios',
      deviceName: 'iPhone de Test'
    });
  });

  test('an undetermined permission raises the system prompt', async () => {
    const { service } = harness({ permission: { status: 'undetermined' }, afterRequest: { status: 'granted', granted: true } });

    expect(await service.enable()).toBe('enabled');
  });

  test('a refused prompt unregisters the device rather than leaving it half-registered', async () => {
    const { service, calls } = harness({ permission: { status: 'undetermined' }, afterRequest: { status: 'denied' } });

    expect(await service.enable()).toBe('denied');
    expect(calls.unregistered).toEqual(['uuid-1']);
  });

  test('a permission denied long ago sends to settings and unregisters', async () => {
    const { service, calls } = harness({ permission: { status: 'denied' } });

    expect(await service.enable()).toBe('denied');
    expect(calls.unregistered).toEqual(['uuid-1']);
  });

  test('Android channels are declared before the token is asked for', async () => {
    const { service, calls } = harness({ platform: 'android' });

    await service.enable();

    expect(calls.channels).toEqual([['acme-orders', 'Orders']]);
  });

  test('no channels are declared on iOS', async () => {
    const { service, calls } = harness();

    await service.enable();

    expect(calls.channels).toEqual([]);
  });
});

describe('sync', () => {
  test('registers silently when the permission is already granted', async () => {
    const { service, calls } = harness();

    expect(await service.sync()).toBe('enabled');
    expect(calls.registered).toHaveLength(1);
  });

  test('never raises the prompt on its own', async () => {
    let prompted = false;
    const { service } = harness({
      permission: { status: 'undetermined' },
      notifications: { requestPermissionsAsync: async () => { prompted = true; return { status: 'granted' }; } }
    });

    expect(await service.sync()).toBe('undetermined');
    expect(prompted).toBe(false);
  });
});

describe('listeners', () => {
  test('a tap goes through the router, so a forbidden route lands on the fallback', async () => {
    const { service, listeners, calls } = harness();
    await service.startListeners('courier');

    listeners.response({ notification: { request: { content: { data: { route: '/orders/o1' } } } } });
    await Promise.resolve(); // an async onAction defers the decision by one tick

    expect(calls.navigated).toEqual(['/notifications']);
  });

  test('a permitted route is followed', async () => {
    const { service, listeners, calls } = harness();
    await service.startListeners('seller');

    listeners.response({ notification: { request: { content: { data: { route: '/orders/o1' } } } } });
    await Promise.resolve();

    expect(calls.navigated).toEqual(['/orders/o1']);
  });

  test('an action handled in place navigates nowhere', async () => {
    const handled = [];
    const { service, listeners, calls } = harness({
      onAction: async (payload) => { handled.push(payload.actionIdentifier); return true; }
    });
    await service.startListeners('seller');

    listeners.response({ actionIdentifier: 'APPROVE', notification: { request: { content: { data: { route: '/orders/o1' } } } } });
    await Promise.resolve();

    expect(handled).toEqual(['APPROVE']);
    expect(calls.navigated).toEqual([]);
  });

  test('stopping the listeners silences a response that arrives afterwards', async () => {
    const { service, listeners, calls } = harness();
    const stop = await service.startListeners('seller');
    const fire = listeners.response;

    stop();
    fire({ notification: { request: { content: { data: { route: '/orders/o1' } } } } });
    await Promise.resolve();

    expect(calls.navigated).toEqual([]);
  });

  test('a cold start opens the notification once, and never again', async () => {
    const coldStart = {
      notification: { request: { identifier: 'n1', content: { data: { route: '/orders/o1' } } } }
    };
    const keystore = createMemoryKeystore();
    const first = harness({ coldStart, keystore });
    await first.service.startListeners('seller');
    await new Promise((resolve) => setImmediate(resolve));

    const second = harness({ coldStart, keystore });
    await second.service.startListeners('seller');
    await new Promise((resolve) => setImmediate(resolve));

    expect(first.calls.navigated).toEqual(['/orders/o1']);
    expect(second.calls.navigated).toEqual([]);
  });

  test('an unsupported device installs nothing and returns a stop that is safe to call', async () => {
    const { service, calls } = harness({ isDevice: false });

    const stop = await service.startListeners('seller');
    stop();

    expect(calls.handler).toBeUndefined();
  });
});

describe('logout', () => {
  test('unregisters, clears the cached notification, then signs out — in that order', async () => {
    const order = [];
    const { service, calls } = harness();
    await service.enable();

    await service.logout(async () => { order.push('logout'); });

    expect(calls.unregistered).toContain('uuid-1');
    expect(calls.cleared).toBe(true);
    expect(order).toEqual(['logout']);
  });

  test('signing out still happens when the server cannot be reached', async () => {
    let signedOut = false;
    const { service } = harness({
      notifications: { clearLastNotificationResponseAsync: async () => { throw new Error('offline'); } }
    });

    await service.logout(async () => { signedOut = true; });

    expect(signedOut).toBe(true);
  });

  test('a registration started before logout cannot re-register after it', async () => {
    const { service, calls } = harness();

    await service.logout(async () => {});
    const state = await service.sync();

    expect(state).toBe('disabled');
    expect(calls.registered).toHaveLength(0);
  });

  test('signing back in unblocks registration', async () => {
    const { service, calls } = harness();
    await service.logout(async () => {});

    service.allowRegistration();
    await service.sync();

    expect(calls.registered).toHaveLength(1);
  });

  test('two logouts at once do the work once', async () => {
    const { service, calls } = harness();
    let signOuts = 0;

    await Promise.all([
      service.logout(async () => { signOuts += 1; }),
      service.logout(async () => { signOuts += 1; })
    ]);

    expect(signOuts).toBe(1);
    expect(calls.unregistered).toHaveLength(1);
  });
});
