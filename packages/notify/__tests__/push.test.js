const { createPushSender } = require('../src');

const goneError = (statusCode) => Object.assign(new Error('Gone'), { statusCode });

function build({ deadIds = [], failIds = [], ...overrides } = {}) {
  const delivered = [];
  const pruned = [];
  const push = createPushSender({
    transport: async (subscription) => {
      if (deadIds.includes(subscription.id)) throw goneError(410);
      if (failIds.includes(subscription.id)) throw new Error('provider timeout');
      delivered.push(subscription.id);
    },
    onGone: async (subscription) => { pruned.push(subscription.id); },
    ...overrides
  });
  return { push, delivered, pruned };
}

describe('one subscription', () => {
  test('a delivery reports delivered', async () => {
    const { push, delivered } = build();

    expect(await push.send({ id: 's1' }, { title: 'Hé' })).toEqual({ status: 'delivered' });
    expect(delivered).toEqual(['s1']);
  });

  test('a DEAD subscription is handed back for pruning — the point of the module', async () => {
    /* Left alone, a subscriber list only accumulates corpses: slower sends,
       noisy logs, and providers that throttle high-failure senders. */
    const { push, pruned } = build({ deadIds: ['s1'] });

    expect(await push.send({ id: 's1' }, {})).toEqual({ status: 'gone' });
    expect(pruned).toEqual(['s1']);
  });

  test('404 and 410 both mean dead; anything else is a plain failure', async () => {
    const { push, pruned } = build({
      transport: async ({ id }) => {
        if (id === 'a') throw goneError(404);
        if (id === 'b') throw goneError(410);
        throw goneError(500);
      }
    });

    expect((await push.send({ id: 'a' }, {})).status).toBe('gone');
    expect((await push.send({ id: 'b' }, {})).status).toBe('gone');
    expect((await push.send({ id: 'c' }, {})).status).toBe('failed');
    expect(pruned).toEqual(['a', 'b']);
  });

  test('the status is found wherever the provider put it', async () => {
    for (const shape of [{ statusCode: 410 }, { status: 410 }, { response: { status: 410 } }]) {
      const push = createPushSender({ transport: async () => { throw Object.assign(new Error('x'), shape); } });
      expect((await push.send({}, {})).status).toBe('gone');
    }
  });

  test('a failing PRUNE does not turn a gone into a failure', async () => {
    const errors = [];
    const { push } = build({
      deadIds: ['s1'],
      onGone: async () => { throw new Error('store down'); },
      logger: { error: (m) => errors.push(m), info() {}, warn() {} }
    });

    expect(await push.send({ id: 's1' }, {})).toEqual({ status: 'gone' });
    expect(errors.join(' ')).toMatch(/store down/);
  });

  test('nothing ever throws at the caller', async () => {
    const { push } = build({ failIds: ['s1'] });

    await expect(push.send({ id: 's1' }, {})).resolves.toMatchObject({ status: 'failed', error: 'provider timeout' });
  });
});

describe('broadcast', () => {
  test('a slow provider call does not delay subscriptions behind it', async () => {
    let releaseSlow;
    const slow = new Promise((resolve) => { releaseSlow = resolve; });
    const started = [];
    const completed = [];
    const push = createPushSender({
      concurrency: 2,
      transport: async ({ id }) => {
        started.push(id);
        if (id === 'slow') await slow;
        completed.push(id);
      }
    });

    const batch = push.broadcast([{ id: 'slow' }, { id: 'fast' }], {});
    await Promise.resolve();
    await Promise.resolve();
    const startedBeforeRelease = [...started];
    const completedBeforeRelease = [...completed];
    releaseSlow();
    await batch;

    expect(startedBeforeRelease).toEqual(['slow', 'fast']);
    expect(completedBeforeRelease).toEqual(['fast']);
  });

  test('never exceeds the configured concurrency', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const push = createPushSender({
      concurrency: 2,
      transport: async ({ id }) => {
        started.push(id);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
      }
    });

    const batch = push.broadcast([{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }], {});
    await Promise.resolve();
    await Promise.resolve();
    const startedBeforeRelease = [...started];
    release();
    await batch;

    expect(startedBeforeRelease).toEqual(['s1', 's2']);
    expect(maxInFlight).toBe(2);
  });

  test('defaults to ten concurrent sends', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let inFlight = 0;
    let maxInFlight = 0;
    const push = createPushSender({
      transport: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
      }
    });

    const subscriptions = Array.from({ length: 11 }, (_, index) => ({ id: `s${index}` }));
    const batch = push.broadcast(subscriptions, {});
    await Promise.resolve();
    await Promise.resolve();
    release();
    await batch;

    expect(maxInFlight).toBe(10);
  });

  test('reports a provider timeout as a failure', async () => {
    jest.useFakeTimers();
    try {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let settled = false;
      const push = createPushSender({
        timeoutMs: 100,
        transport: async () => gate
      });

      const batch = push.broadcast([{ id: 'slow' }], {}).then((report) => {
        settled = true;
        return report;
      });
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);
      const settledAtDeadline = settled;
      release();
      const report = await batch;

      expect(settledAtDeadline).toBe(true);
      expect(report).toEqual({
        delivered: 0,
        gone: 0,
        failed: 1,
        errors: ['Push delivery timed out after 100ms.']
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('keeps errors in input order when sends finish out of order', async () => {
    const controls = new Map();
    const push = createPushSender({
      concurrency: 3,
      transport: ({ id }) => new Promise((resolve, reject) => {
        controls.set(id, { resolve, reject });
      })
    });

    const batch = push.broadcast([{ id: 'first' }, { id: 'second' }, { id: 'third' }], {});
    await Promise.resolve();
    controls.get('third').reject(new Error('third failed'));
    controls.get('first').reject(new Error('first failed'));
    controls.get('second').reject(new Error('second failed'));

    expect(await batch).toEqual({
      delivered: 0,
      gone: 0,
      failed: 3,
      errors: ['first failed', 'second failed', 'third failed']
    });
  });

  test('one dead or failing subscription does not stop the others', async () => {
    const { push, delivered, pruned } = build({ deadIds: ['s2'], failIds: ['s3'] });

    const report = await push.broadcast([{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }], {});

    expect(report).toMatchObject({ delivered: 2, gone: 1, failed: 1 });
    expect(report.errors).toEqual(['provider timeout']);
    expect(delivered).toEqual(['s1', 's4']);
    expect(pruned).toEqual(['s2']);
  });

  test('an empty list reports cleanly', async () => {
    const { push } = build();

    expect(await push.broadcast([], {})).toMatchObject({ delivered: 0, gone: 0, failed: 0 });
    expect(await push.broadcast(null, {})).toMatchObject({ delivered: 0 });
  });
});

describe('wiring', () => {
  test('a sender without a transport is refused up front', () => {
    expect(() => createPushSender({})).toThrow(/transport/);
  });
});
