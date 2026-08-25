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
