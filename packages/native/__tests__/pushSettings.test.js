const { resolvePushAction, isPushEnabled, createPushSettingsController } = require('../src');

describe('resolvePushAction', () => {
  test('each state has exactly one thing the button can do', () => {
    expect(resolvePushAction('enabled')).toBe('disable');
    expect(resolvePushAction('disabled')).toBe('enable');
    expect(resolvePushAction('undetermined')).toBe('enable');
    expect(resolvePushAction('denied')).toBe('open-settings');
    expect(resolvePushAction('error')).toBe('retry');
  });

  test('while loading, the button does nothing', () => {
    expect(resolvePushAction('loading')).toBeNull();
    expect(resolvePushAction('whatever')).toBeNull();
  });

  test('isPushEnabled is true for the enabled state alone', () => {
    expect(isPushEnabled('enabled')).toBe(true);
    expect(isPushEnabled('undetermined')).toBe(false);
  });
});

describe('createPushSettingsController', () => {
  function harness(overrides = {}) {
    const calls = [];
    const operations = {
      getState: async () => 'disabled',
      enable: async () => { calls.push('enable'); },
      disable: async () => { calls.push('disable'); },
      openSettings: async () => { calls.push('open-settings'); },
      ...overrides
    };
    const snapshots = [];
    const controller = createPushSettingsController(operations, (s) => snapshots.push({ ...s }));
    return { controller, snapshots, calls };
  }

  test('activating reads the real state and publishes loading then the answer', async () => {
    const { controller, snapshots } = harness({ getState: async () => 'enabled' });

    const { ready } = controller.activate();
    await ready;

    expect(snapshots).toEqual([
      { state: 'loading', busy: true },
      { state: 'enabled', busy: false }
    ]);
  });

  test('acting runs the operation for the current state, then re-reads it', async () => {
    let state = 'disabled';
    const { controller, calls, snapshots } = harness({
      getState: async () => state,
      enable: async () => { calls.push('enable'); state = 'enabled'; }
    });
    const { ready } = controller.activate();
    await ready;
    snapshots.length = 0;

    await controller.act();

    expect(calls).toEqual(['enable']);
    expect(snapshots.at(-1)).toEqual({ state: 'enabled', busy: false });
  });

  test('an operation that throws lands on error, not on a silent no-op', async () => {
    const { controller, snapshots } = harness({ enable: async () => { throw new Error('no network'); } });
    const { ready } = controller.activate();
    await ready;

    await controller.act();

    expect(snapshots.at(-1)).toEqual({ state: 'error', busy: false });
  });

  test('a second act while the first is running is ignored', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { controller, calls } = harness({ enable: async () => { calls.push('enable'); await gate; } });
    const { ready } = controller.activate();
    await ready;

    const first = controller.act();
    await controller.act();
    release();
    await first;

    expect(calls).toEqual(['enable']);
  });

  test('a disposed screen publishes nothing more, even if its request was in flight', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { controller, snapshots } = harness({ getState: async () => { await gate; return 'enabled'; } });

    const { ready, dispose } = controller.activate();
    dispose();
    release();
    await ready;

    expect(snapshots).toEqual([{ state: 'loading', busy: true }]);
  });

  test('re-activating supersedes the previous screen', async () => {
    const { controller, snapshots } = harness({ getState: async () => 'enabled' });
    const first = controller.activate();
    const second = controller.activate();
    await Promise.all([first.ready, second.ready]);

    expect(snapshots.filter((s) => s.state === 'enabled')).toHaveLength(1);
  });

  test('refresh before activation does nothing rather than throwing', async () => {
    const { controller, snapshots } = harness();

    await controller.refresh();
    await controller.act();

    expect(snapshots).toEqual([]);
  });
});
