const {
  createMemoryEventLog,
  createWebhookHandler,
  DUPLICATE,
  HANDLED,
  IGNORED,
  UNRELATED
} = require('../src');

/** A signature check shaped like a real one: it throws on a bad payload. */
const verifier = (secret = 'whsec_test') => ({ payload, headers, secret: given }) => {
  if (given !== secret) throw new Error('No signatures found matching the expected signature');
  if (headers['stripe-signature'] !== 'good') throw new Error('No signatures found matching the expected signature');
  return JSON.parse(payload.toString());
};

const event = (type, id = 'evt_1', data = {}) => Buffer.from(JSON.stringify({ id, type, data: { object: data } }));

const send = (handler, payload, signature = 'good') =>
  handler.receive({ payload, headers: { 'stripe-signature': signature } });

describe('signature', () => {
  test('a valid event reaches its handler', async () => {
    const seen = [];
    const handler = createWebhookHandler({
      verify: verifier(),
      secret: 'whsec_test',
      events: { 'checkout.session.completed': async (e) => { seen.push(e.id); } }
    });

    const response = await send(handler, event('checkout.session.completed'));

    expect(response).toEqual({ status: 200, body: { received: true, status: HANDLED, type: 'checkout.session.completed' } });
    expect(seen).toEqual(['evt_1']);
  });

  test('a bad signature is 400, NOT 500 — retrying would change nothing', async () => {
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test', events: { 'x': async () => {} }
    });

    const response = await send(handler, event('x'), 'forged');

    expect(response.status).toBe(400);
    expect(response.body.reason).toBe('invalid-signature');
  });

  test('a wrong secret is refused just as firmly', async () => {
    const handler = createWebhookHandler({
      verify: verifier('whsec_real'), secret: 'whsec_stale', events: { 'x': async () => {} }
    });

    expect((await send(handler, event('x'))).status).toBe(400);
  });

  test('the secret can be a function, so it is read fresh every time', async () => {
    let current = 'whsec_old';
    const handler = createWebhookHandler({
      verify: verifier('whsec_new'), secret: () => current, events: { 'x': async () => {} }
    });

    expect((await send(handler, event('x'))).status).toBe(400);

    /* Rotated from an interface, no restart. */
    current = 'whsec_new';
    expect((await send(handler, event('x'))).status).toBe(200);
  });

  test('a malformed event is refused rather than half-handled', async () => {
    const handler = createWebhookHandler({
      verify: () => ({ id: 'evt_1' }), events: { 'x': async () => {} }
    });

    expect((await send(handler, Buffer.from('{}'))).body.reason).toBe('malformed-event');
  });
});

describe('what is not ours', () => {
  test('an unknown event type is ACKNOWLEDGED, never rejected', async () => {
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test',
      events: { 'checkout.session.completed': async () => {} }
    });

    const response = await send(handler, event('invoice.payment_failed', 'evt_9'));

    /* 404 here makes the provider retry for days and flag the endpoint —
       for an event that was never ours to handle. */
    expect(response.status).toBe(200);
    expect(response.body.status).toBe(IGNORED);
  });

  test('a handler can declare an event none of its business, and still answer 200', async () => {
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test',
      events: {
        'checkout.session.completed': async (e, { unrelated }) =>
          unrelated(`session ${e.data.object.reference} belongs to another flow`)
      }
    });

    const response = await send(handler, event('checkout.session.completed', 'evt_2', { reference: 'psub_77' }));

    expect(response).toMatchObject({ status: 200, body: { received: true, status: UNRELATED } });
  });
});

describe('replays', () => {
  test('the same event twice acts once', async () => {
    let charges = 0;
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test', eventLog: createMemoryEventLog(),
      events: { 'checkout.session.completed': async () => { charges += 1; } }
    });

    await send(handler, event('checkout.session.completed', 'evt_5'));
    const second = await send(handler, event('checkout.session.completed', 'evt_5'));

    expect(charges).toBe(1);
    expect(second).toMatchObject({ status: 200, body: { status: DUPLICATE } });
  });

  test('different events are not confused with each other', async () => {
    let charges = 0;
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test', eventLog: createMemoryEventLog(),
      events: { 'checkout.session.completed': async () => { charges += 1; } }
    });

    await send(handler, event('checkout.session.completed', 'evt_1'));
    await send(handler, event('checkout.session.completed', 'evt_2'));

    expect(charges).toBe(2);
  });

  test('a FAILED event is not recorded — the retry must be allowed to work', async () => {
    let attempts = 0;
    const log = createMemoryEventLog();
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test', eventLog: log,
      events: {
        'checkout.session.completed': async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('database unavailable');
        }
      }
    });

    expect((await send(handler, event('checkout.session.completed', 'evt_7'))).status).toBe(500);
    expect((await send(handler, event('checkout.session.completed', 'evt_7'))).status).toBe(200);
    expect(attempts).toBe(2);
  });

  test('an event declared not ours is not recorded either', async () => {
    const log = createMemoryEventLog();
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test', eventLog: log,
      events: { 'checkout.session.completed': async (_e, { unrelated }) => unrelated('another flow') }
    });

    await send(handler, event('checkout.session.completed', 'evt_8'));

    expect(log.size()).toBe(0);
  });

  test('without an event log, nothing is remembered — and that is visible', async () => {
    let charges = 0;
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test',
      events: { 'checkout.session.completed': async () => { charges += 1; } }
    });

    await send(handler, event('checkout.session.completed', 'evt_5'));
    await send(handler, event('checkout.session.completed', 'evt_5'));

    expect(charges).toBe(2);
  });
});

describe('side effects', () => {
  test('a failed email does NOT fail the webhook', async () => {
    const logged = [];
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test',
      logger: { info() {}, warn() {}, error: (m) => logged.push(m) },
      events: {
        'checkout.session.completed': async (_e, { sideEffect }) => {
          await sideEffect('confirmation email', async () => { throw new Error('smtp down'); });
        }
      }
    });

    const response = await send(handler, event('checkout.session.completed'));

    /* The money is taken and the order confirmed. A 500 here would ask the
       provider to replay an event that WAS handled. */
    expect(response.status).toBe(200);
    expect(logged.join(' ')).toMatch(/confirmation email/);
  });

  test('a successful side effect returns its value', async () => {
    let captured;
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test',
      events: {
        'checkout.session.completed': async (_e, { sideEffect }) => {
          captured = await sideEffect('email', async () => 'sent');
        }
      }
    });

    await send(handler, event('checkout.session.completed'));

    expect(captured).toBe('sent');
  });

  test('a real failure in the handler IS a 500 — that retry can help', async () => {
    const handler = createWebhookHandler({
      verify: verifier(), secret: 'whsec_test',
      events: { 'checkout.session.completed': async () => { throw new Error('database unavailable'); } }
    });

    expect((await send(handler, event('checkout.session.completed'))).status).toBe(500);
  });
});

describe('wiring', () => {
  test('a handler with no verifier or no events is refused up front', () => {
    expect(() => createWebhookHandler({ events: { x: () => {} } })).toThrow(/verify/);
    expect(() => createWebhookHandler({ verify: () => {} })).toThrow(/events/);
  });
});
