const {
  UPDATE_APPLY_GRACE_MS,
  UPDATE_CHECK_INTERVAL_MS,
  describeRelease,
  shouldApplyUpdate,
  shouldCheckForUpdate,
  createUpdateWatcher
} = require('../src');

const base = { enabled: true, lastCheckAt: null, now: 1_000_000, online: true };

describe('shouldCheckForUpdate', () => {
  test('a build without updates asks for nothing', () => {
    expect(shouldCheckForUpdate({ ...base, enabled: false })).toBe(false);
  });

  test('offline, nothing is asked', () => {
    expect(shouldCheckForUpdate({ ...base, online: false })).toBe(false);
  });

  test('the first check goes at once, the next waits an hour', () => {
    expect(shouldCheckForUpdate(base)).toBe(true);
    expect(shouldCheckForUpdate({ ...base, lastCheckAt: base.now - UPDATE_CHECK_INTERVAL_MS + 1 })).toBe(false);
    expect(shouldCheckForUpdate({ ...base, lastCheckAt: base.now - UPDATE_CHECK_INTERVAL_MS })).toBe(true);
  });

  test('the interval is a setting', () => {
    expect(shouldCheckForUpdate({ ...base, lastCheckAt: base.now - 10 }, 10)).toBe(true);
    expect(shouldCheckForUpdate({ ...base, lastCheckAt: base.now - 9 }, 10)).toBe(false);
  });
});

describe('shouldApplyUpdate', () => {
  test('only still in the background, with an empty write queue', () => {
    expect(shouldApplyUpdate({ downloaded: true, stillInBackground: true, pendingWrites: 0 })).toBe(true);
    expect(shouldApplyUpdate({ downloaded: true, stillInBackground: false, pendingWrites: 0 })).toBe(false);
    expect(shouldApplyUpdate({ downloaded: true, stillInBackground: true, pendingWrites: 2 })).toBe(false);
    expect(shouldApplyUpdate({ downloaded: false, stillInBackground: true, pendingWrites: 0 })).toBe(false);
  });

  test('the grace period covers a trip to answer a text', () => {
    expect(UPDATE_APPLY_GRACE_MS).toBeGreaterThanOrEqual(30 * 1000);
  });
});

test('the release name tells the binary from the update it runs', () => {
  expect(describeRelease({ version: '1.1.0', updateId: null, isEmbeddedLaunch: true })).toBe('1.1.0+embedded');
  expect(describeRelease({ version: '1.1.0', updateId: '3f2a9c1d-0000-4000-8000-000000000000', isEmbeddedLaunch: true })).toBe('1.1.0+embedded');
  expect(describeRelease({ version: '1.1.0', updateId: '3f2a9c1d-0000-4000-8000-000000000000', isEmbeddedLaunch: false })).toBe('1.1.0+3f2a9c1d');
  expect(describeRelease({ updateId: null, isEmbeddedLaunch: true })).toBe('0.0.0+embedded');
});

function harness(overrides = {}) {
  const calls = { checks: 0, fetches: 0, reloads: 0, errors: [] };
  const appState = {
    currentState: 'active',
    listener: null,
    removed: false,
    addEventListener(event, fn) {
      this.listener = fn;
      return { remove: () => { this.removed = true; } };
    },
    go(state) {
      this.currentState = state;
      this.listener(state);
    }
  };
  const updates = {
    isEnabled: true,
    isEmbeddedLaunch: false,
    updateId: 'abcdef0123456789',
    channel: 'production',
    runtimeVersion: '1.0.0',
    checkForUpdateAsync: async () => {
      calls.checks += 1;
      if (overrides.checkThrows) throw new Error('update server down');
      return { isAvailable: overrides.available !== false };
    },
    fetchUpdateAsync: async () => {
      calls.fetches += 1;
      return { isNew: true };
    },
    reloadAsync: async () => {
      calls.reloads += 1;
    },
    ...overrides.updates
  };
  let pending = overrides.pending || 0;
  let online = overrides.online !== false;
  let clock = 5_000_000;
  const watcher = createUpdateWatcher({
    updates,
    appState,
    isOnline: () => online,
    pendingWrites: () => pending,
    onError: (error, context) => calls.errors.push(context.where),
    graceMs: overrides.graceMs,
    now: () => clock
  });
  return {
    watcher,
    appState,
    calls,
    setPending: (n) => { pending = n; },
    setOnline: (value) => { online = value; },
    advanceClock: (ms) => { clock += ms; }
  };
}

describe('createUpdateWatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('start() checks and downloads, once however many times it runs', async () => {
    const h = harness();
    h.watcher.start();
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.calls.checks).toBe(1);
    expect(h.calls.fetches).toBe(1);
    expect(h.watcher.hasPendingUpdate()).toBe(true);
    h.watcher.stop();
    expect(h.appState.removed).toBe(true);
  });

  test('returning to the foreground re-checks only once the interval has passed', async () => {
    const h = harness({ available: false });
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    h.appState.go('background');
    h.appState.go('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(h.calls.checks).toBe(1);
    h.advanceClock(UPDATE_CHECK_INTERVAL_MS);
    h.appState.go('background');
    h.appState.go('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(h.calls.checks).toBe(2);
  });

  test('offline, the server is not asked', async () => {
    const h = harness({ online: false });
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.calls.checks).toBe(0);
  });

  test('an unreachable update server is reported, not thrown', async () => {
    const h = harness({ checkThrows: true });
    await expect(h.watcher.check()).resolves.toBe(false);
    expect(h.calls.errors).toEqual(['checkForUpdate']);
  });

  test('a downloaded update applies after the grace period in the background', async () => {
    const h = harness();
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    h.appState.go('background');
    await jest.advanceTimersByTimeAsync(UPDATE_APPLY_GRACE_MS - 1);
    expect(h.calls.reloads).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.calls.reloads).toBe(1);
    expect(h.watcher.hasPendingUpdate()).toBe(false);
  });

  test('coming back within the grace period cancels the reload', async () => {
    const h = harness();
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    h.appState.go('background');
    await jest.advanceTimersByTimeAsync(5_000);
    h.appState.go('active');
    await jest.advanceTimersByTimeAsync(UPDATE_APPLY_GRACE_MS * 2);
    expect(h.calls.reloads).toBe(0);
    expect(h.watcher.hasPendingUpdate()).toBe(true);
  });

  test('a quick return then a new departure restarts the full grace period', async () => {
    const h = harness();
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    h.appState.go('background');
    await jest.advanceTimersByTimeAsync(UPDATE_APPLY_GRACE_MS - 5_000);
    h.appState.go('active');
    h.appState.go('background');
    /* The first departure's timer must be gone: reloading five seconds into
       the second trip is exactly the round trip the grace period protects. */
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.calls.reloads).toBe(0);
    await jest.advanceTimersByTimeAsync(UPDATE_APPLY_GRACE_MS - 5_000);
    expect(h.calls.reloads).toBe(1);
  });

  test('a late timer firing in the foreground reloads nothing (iOS frozen timer)', async () => {
    const h = harness();
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    h.appState.go('background');
    /* The OS thaws the timer on return, before the change event is delivered. */
    h.appState.currentState = 'active';
    await jest.advanceTimersByTimeAsync(UPDATE_APPLY_GRACE_MS);
    expect(h.calls.reloads).toBe(0);
  });

  test('queued writes hold the reload back', async () => {
    const h = harness({ pending: 3 });
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    h.appState.go('background');
    await jest.advanceTimersByTimeAsync(UPDATE_APPLY_GRACE_MS);
    expect(h.calls.reloads).toBe(0);
    /* Next time around, with the queue flushed, it goes. */
    h.setPending(0);
    h.appState.go('active');
    h.appState.go('background');
    await jest.advanceTimersByTimeAsync(UPDATE_APPLY_GRACE_MS);
    expect(h.calls.reloads).toBe(1);
  });

  test('nothing downloaded, no timer', async () => {
    const h = harness({ available: false });
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    h.appState.go('background');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the grace period is a setting', async () => {
    const h = harness({ graceMs: 1_000 });
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    h.appState.go('background');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.calls.reloads).toBe(1);
  });

  test('a failing reload is reported', async () => {
    const h = harness({ updates: { reloadAsync: async () => { throw new Error('nope'); } } });
    h.watcher.start();
    await jest.advanceTimersByTimeAsync(0);
    h.appState.go('background');
    await jest.advanceTimersByTimeAsync(UPDATE_APPLY_GRACE_MS);
    expect(h.calls.errors).toEqual(['reloadAsync']);
  });

  test('describeBuild names the update the phone runs', () => {
    const h = harness();
    expect(h.watcher.describeBuild('2.0.0')).toEqual({
      updateId: 'abcdef0123456789',
      channel: 'production',
      runtimeVersion: '1.0.0',
      isEmbeddedLaunch: false,
      release: '2.0.0+abcdef01'
    });
  });

  test('the modules are required', () => {
    expect(() => createUpdateWatcher({ appState: {} })).toThrow(/updates/);
    expect(() => createUpdateWatcher({ updates: {} })).toThrow(/appState/);
  });
});
