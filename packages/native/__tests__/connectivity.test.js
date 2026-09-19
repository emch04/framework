const {
  TRANSPORT_BLACKOUT_MS,
  readReachability,
  readConnectionLink,
  isDefinitelyOffline,
  worthAttempting,
  hasComeBack,
  shouldDeclareTransportDown,
  createConnectivityMonitor
} = require('../src');

describe('readReachability', () => {
  test('the OS "no Internet" is not enough to declare an outage', () => {
    /* A wifi that fails Google's validation probe still carries our requests:
       the app showed "offline" on wifi alone and only recovered with mobile
       data switched on too. */
    const unvalidatedWifi = { isConnected: true, isInternetReachable: false, type: 'wifi' };
    expect(readReachability(unvalidatedWifi)).toBe('unknown');
    expect(isDefinitelyOffline(unvalidatedWifi)).toBe(false);
    expect(worthAttempting(unvalidatedWifi)).toBe(true);
    expect(readConnectionLink(unvalidatedWifi)).toBe('wifi');
  });

  test('offline only without any interface', () => {
    expect(readReachability({ isConnected: false, isInternetReachable: false, type: 'none' })).toBe('offline');
    expect(readReachability({ isConnected: false, isInternetReachable: null })).toBe('offline');
    expect(readReachability({ isConnected: true, isInternetReachable: true })).toBe('online');
  });

  test('the OS being undecided is not an outage', () => {
    expect(readReachability({ isConnected: true, isInternetReachable: null })).toBe('unknown');
    expect(readReachability(null)).toBe('unknown');
    expect(readReachability(undefined)).toBe('unknown');
    expect(isDefinitelyOffline({ isConnected: true, isInternetReachable: null })).toBe(false);
    expect(worthAttempting({ isConnected: true, isInternetReachable: null })).toBe(true);
    expect(worthAttempting({ isConnected: false, isInternetReachable: null })).toBe(false);
  });
});

describe('readConnectionLink', () => {
  test('wifi, ethernet and wimax are the free side', () => {
    for (const type of ['wifi', 'ethernet', 'wimax', 'WIFI']) {
      expect(readConnectionLink({ isConnected: true, isInternetReachable: true, type })).toBe('wifi');
    }
  });

  test('cellular is metered, the unnamed stays unknown', () => {
    expect(readConnectionLink({ isConnected: true, isInternetReachable: true, type: 'cellular' })).toBe('cellular');
    expect(readConnectionLink({ isConnected: true, isInternetReachable: true, type: 'bluetooth' })).toBe('unknown');
    expect(readConnectionLink({ isConnected: true, isInternetReachable: true })).toBe('unknown');
    expect(readConnectionLink(null)).toBe('unknown');
  });

  test('no interface means no link, whatever the type says', () => {
    expect(readConnectionLink({ isConnected: false, isInternetReachable: null, type: 'wifi' })).toBe('none');
    expect(readConnectionLink({ isConnected: true, isInternetReachable: null, type: 'none' })).toBe('none');
  });
});

describe('shouldDeclareTransportDown', () => {
  test('a slow server does not flip the app offline on a healthy network', () => {
    expect(shouldDeclareTransportDown({ reason: 'timeout', reachability: 'online' })).toBe(false);
  });

  test('a timeout on an unproven network does', () => {
    expect(shouldDeclareTransportDown({ reason: 'timeout', reachability: 'unknown' })).toBe(true);
    expect(shouldDeclareTransportDown({ reason: 'timeout', reachability: 'offline' })).toBe(true);
  });

  test('a transport refusal is conclusive whatever the OS says', () => {
    expect(shouldDeclareTransportDown({ reason: 'unreachable', reachability: 'online' })).toBe(true);
  });
});

test('only the RETURN of the network restarts work', () => {
  expect(hasComeBack('offline', 'online')).toBe(true);
  expect(hasComeBack('online', 'online')).toBe(false);
  expect(hasComeBack('unknown', 'online')).toBe(false);
  expect(hasComeBack('offline', 'unknown')).toBe(false);
});

function fakeNetInfo(initial) {
  let listener = null;
  let current = initial;
  return {
    removed: 0,
    addEventListener(fn) {
      listener = fn;
      return () => {
        this.removed += 1;
        listener = null;
      };
    },
    fetch: async () => current,
    emit(state) {
      current = state;
      if (listener) listener(state);
    },
    get listening() {
      return Boolean(listener);
    }
  };
}

describe('createConnectivityMonitor', () => {
  let monitor;

  beforeEach(() => {
    jest.useFakeTimers();
    monitor = createConnectivityMonitor();
    monitor.setSnapshot({ isConnected: true, isInternetReachable: null, type: 'wifi' });
  });

  afterEach(() => {
    monitor.stop();
    jest.useRealTimers();
  });

  test('a single subscription to the OS, however many times start() runs', async () => {
    const netInfo = fakeNetInfo({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    const spy = jest.spyOn(netInfo, 'addEventListener');
    const watched = createConnectivityMonitor({ netInfo });
    watched.start();
    watched.start();
    expect(spy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(watched.getReachability()).toBe('online');
    watched.stop();
    expect(netInfo.removed).toBe(1);
    expect(netInfo.listening).toBe(false);
  });

  test('a NetInfo "no Internet" leaves requests flowing', () => {
    const netInfo = fakeNetInfo(null);
    const watched = createConnectivityMonitor({ netInfo });
    watched.start();
    netInfo.emit({ isConnected: true, isInternetReachable: false, type: 'wifi' });
    expect(watched.isOffline()).toBe(false);
    expect(watched.shouldAttemptRequest()).toBe(true);
    expect(watched.getConnectionLink()).toBe('wifi');
    watched.stop();
  });

  test('a transport failure is remembered for the blackout, then lapses', async () => {
    monitor.noteTransportFailure('unreachable');
    expect(monitor.isTransportDown()).toBe(true);
    expect(monitor.isOffline()).toBe(true);
    expect(monitor.shouldAttemptRequest()).toBe(false);
    await jest.advanceTimersByTimeAsync(TRANSPORT_BLACKOUT_MS - 1);
    expect(monitor.isTransportDown()).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    expect(monitor.isTransportDown()).toBe(false);
    expect(monitor.shouldAttemptRequest()).toBe(true);
  });

  test('the blackout length is a setting', async () => {
    const short = createConnectivityMonitor({ blackoutMs: 5_000 });
    short.noteTransportFailure();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(short.isTransportDown()).toBe(false);
    short.stop();
  });

  test('a timeout while the OS affirms online blames the server, not the network', () => {
    monitor.setSnapshot({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    monitor.noteTransportFailure('timeout');
    expect(monitor.isTransportDown()).toBe(false);
    monitor.noteTransportFailure('unreachable');
    expect(monitor.isTransportDown()).toBe(true);
  });

  test('the blackout is news: subscribers hear it once, not on every repeat', () => {
    const listener = jest.fn();
    monitor.subscribe(listener);
    monitor.noteTransportFailure();
    monitor.noteTransportFailure();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('an expired blackout does not silence the next one', async () => {
    const listener = jest.fn();
    monitor.subscribe(listener);
    monitor.noteTransportFailure();
    await jest.advanceTimersByTimeAsync(TRANSPORT_BLACKOUT_MS);
    listener.mockClear();
    monitor.noteTransportFailure();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('the lapse of the blackout is news too: screens repaint without being asked', async () => {
    const listener = jest.fn();
    monitor.noteTransportFailure();
    monitor.subscribe(listener);
    await jest.advanceTimersByTimeAsync(TRANSPORT_BLACKOUT_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(monitor.isOffline()).toBe(false);
  });

  test('at expiry the probe asks again; its success announces the recovery', async () => {
    const comeback = jest.fn();
    const stop = monitor.onComeback(comeback);
    const probe = jest.fn(async () => monitor.noteTransportSuccess());
    monitor.setRecoveryProbe(probe);

    monitor.noteTransportFailure('unreachable');
    expect(probe).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(TRANSPORT_BLACKOUT_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.isTransportDown()).toBe(false);
    expect(comeback).toHaveBeenCalledTimes(1);
    stop();
  });

  test('a failing probe restarts the blackout, without announcing recovery', async () => {
    const comeback = jest.fn();
    monitor.onComeback(comeback);
    const probe = jest.fn(async () => monitor.noteTransportFailure('unreachable'));
    monitor.setRecoveryProbe(probe);

    monitor.noteTransportFailure('unreachable');
    await jest.advanceTimersByTimeAsync(TRANSPORT_BLACKOUT_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.isTransportDown()).toBe(true);
    expect(comeback).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(TRANSPORT_BLACKOUT_MS);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test('a probe that throws is swallowed', async () => {
    monitor.setRecoveryProbe(() => {
      throw new Error('boom');
    });
    monitor.noteTransportFailure();
    await expect(jest.advanceTimersByTimeAsync(TRANSPORT_BLACKOUT_MS)).resolves.not.toThrow();
  });

  test('the OS affirms no network: no probe goes out', async () => {
    const probe = jest.fn(async () => undefined);
    monitor.setRecoveryProbe(probe);
    monitor.setSnapshot({ isConnected: false, isInternetReachable: false, type: 'none' });
    monitor.noteTransportFailure('unreachable');
    await jest.advanceTimersByTimeAsync(TRANSPORT_BLACKOUT_MS);
    expect(probe).not.toHaveBeenCalled();
  });

  test('a success without a prior blackout announces nothing', () => {
    const comeback = jest.fn();
    const listener = jest.fn();
    monitor.onComeback(comeback);
    monitor.subscribe(listener);
    monitor.noteTransportSuccess();
    expect(comeback).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  test('the radio coming back fires the comeback once and clears the blackout', () => {
    const comeback = jest.fn();
    monitor.onComeback(comeback);
    monitor.setSnapshot({ isConnected: false, isInternetReachable: null, type: 'none' });
    monitor.noteTransportFailure();
    monitor.setSnapshot({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    expect(comeback).toHaveBeenCalledTimes(1);
    expect(monitor.isTransportDown()).toBe(false);
    monitor.setSnapshot({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    expect(comeback).toHaveBeenCalledTimes(1);
  });

  test('a change of link alone is published: wifi to cellular matters to what costs', () => {
    monitor.setSnapshot({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    const listener = jest.fn();
    monitor.subscribe(listener);
    monitor.setSnapshot({ isConnected: true, isInternetReachable: true, type: 'cellular' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(monitor.getConnectionLink()).toBe('cellular');
    monitor.setSnapshot({ isConnected: true, isInternetReachable: true, type: 'cellular' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('unsubscribing stops the notifications', () => {
    const listener = jest.fn();
    const unsubscribe = monitor.subscribe(listener);
    unsubscribe();
    monitor.noteTransportFailure();
    expect(listener).not.toHaveBeenCalled();
  });

  test('refresh() re-reads the OS without firing the comeback', async () => {
    const netInfo = fakeNetInfo({ isConnected: false, isInternetReachable: null, type: 'none' });
    const watched = createConnectivityMonitor({ netInfo });
    watched.setSnapshot({ isConnected: false, isInternetReachable: null, type: 'none' });
    const comeback = jest.fn();
    watched.onComeback(comeback);
    netInfo.emit({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    await expect(watched.refresh()).resolves.toBe(true);
    expect(watched.getReachability()).toBe('online');
    expect(comeback).not.toHaveBeenCalled();
  });

  test('start() without an adapter says so', () => {
    expect(() => createConnectivityMonitor().start()).toThrow(/netInfo/);
  });
});
