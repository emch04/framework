const { createTimerRegistry } = require('../src');

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

describe('timer registry', () => {
  let registry;
  beforeEach(() => { registry = createTimerRegistry(); });
  afterEach(() => registry.stopAll());

  test('a tracked interval really stops — it never fires again', async () => {
    let wakes = 0;
    registry.track(setInterval(() => { wakes += 1; }, 5));

    await wait(40);
    const before = wakes;
    expect(before).toBeGreaterThan(0);

    registry.stopAll();
    await wait(40);

    /* The point of the file: NO wake after the stop. A test that only checked
       `size() === 0` would pass on a registry that forgets its timers without
       clearing them. */
    expect(wakes).toBe(before);
  });

  test('a tracked timeout stopped before its time never fires', async () => {
    let fired = false;
    registry.after(30, () => { fired = true; });

    registry.stopAll();
    await wait(60);

    expect(fired).toBe(false);
  });

  test('tracking unrefs — a background timer never keeps the process alive', () => {
    const timer = registry.every(1000, () => {});
    expect(timer.hasRef()).toBe(false);
  });

  test('the registry empties, and stopping twice is harmless', () => {
    registry.every(1000, () => {});
    registry.track(setTimeout(() => {}, 1000), { kind: 'timeout' });
    expect(registry.size()).toBe(2);

    registry.stopAll();
    expect(registry.size()).toBe(0);
    expect(() => registry.stopAll()).not.toThrow();
  });

  test('track returns the timer, to read as one line', () => {
    const timer = registry.track(setInterval(() => {}, 1000));
    expect(timer).toBeTruthy();
  });

  test('tracking the same timer twice keeps one entry', () => {
    const timer = setInterval(() => {}, 1000);
    registry.track(timer);
    registry.track(timer);
    expect(registry.size()).toBe(1);
  });

  test('the same key replaces the previous timer — a double start() is not a double job', async () => {
    let first = 0;
    let second = 0;
    registry.every(5, () => { first += 1; }, { key: 'sweep' });
    registry.every(5, () => { second += 1; }, { key: 'sweep' });

    await wait(40);

    expect(first).toBe(0);
    expect(second).toBeGreaterThan(0);
    expect(registry.size()).toBe(1);
  });

  test('a fired timeout is forgotten — one-shot timers do not grow the registry', async () => {
    registry.after(1, () => {});
    expect(registry.size()).toBe(1);

    await wait(20);
    expect(registry.size()).toBe(0);
  });

  test('cancel clears one timer and leaves the others', async () => {
    let wakes = 0;
    const cancelled = registry.every(5, () => { wakes += 1; });
    registry.every(1000, () => {});

    expect(registry.cancel(cancelled)).toBe(true);
    await wait(30);

    expect(wakes).toBe(0);
    expect(registry.size()).toBe(1);
    expect(registry.cancel(cancelled)).toBe(false);
  });

  test('one clear that throws does not leave the other timers running', () => {
    const cleared = [];
    const custom = createTimerRegistry({
      timers: {
        clearInterval: (timer) => {
          if (timer === 'broken') throw new Error('cannot clear');
          cleared.push(timer);
        }
      }
    });
    custom.track('broken');
    custom.track('fine');

    expect(() => custom.stopAll()).not.toThrow();
    expect(cleared).toEqual(['fine']);
  });
});

describe('giving up on work already started', () => {
  test('after stopAll, isStopped tells a running tick to give up', () => {
    const registry = createTimerRegistry();
    registry.every(1000, () => {});
    expect(registry.isStopped()).toBe(false);

    registry.stopAll();
    expect(registry.isStopped()).toBe(true);
  });

  test('tracking reopens: a restarted service does not inherit the shutdown', () => {
    const registry = createTimerRegistry();
    registry.stopAll();
    expect(registry.isStopped()).toBe(true);

    registry.every(1000, () => {});
    expect(registry.isStopped()).toBe(false);
    registry.stopAll();
  });
});
