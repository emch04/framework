const { createHmac } = require('node:crypto');
const { createMemoryEventLog } = require('@astratra/payments');
const { createSendcloudCarrier, createCarrierWebhook } = require('../src');

const SECRET = 'sec_test';
const carrier = createSendcloudCarrier({ publicKey: 'pub_test', secretKey: SECRET, sender: { addressId: 1, country: 'FR' }, fetch: async () => { throw new Error('no network in tests'); } });
const sign = (raw, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
const body = (message, extra = {}) => Buffer.from(JSON.stringify({
  action: 'parcel_status_changed', timestamp: 1760000000,
  parcel: { id: 991, tracking_number: '6A123', tracking_url: 'https://track.test/6A123', status: { id: 3, message } },
  ...extra
}));

function setup(handlers = {}) {
  const seen = [];
  const eventLog = createMemoryEventLog();
  const webhook = createCarrierWebhook({
    carrier,
    eventLog,
    onEvent: async (event) => { seen.push(['event', event.message]); },
    onPickedUp: async (event) => { seen.push(['picked_up', event.parcelId]); },
    onDelivered: async (event) => { seen.push(['delivered', event.parcelId]); },
    onIncident: async (event) => { seen.push(['incident', event.trackingNumber]); },
    ...handlers
  });
  const send = (raw, signature = sign(raw)) => webhook.receive({ payload: raw, headers: { 'sendcloud-signature': signature } });
  return { webhook, send, seen, eventLog };
}

describe('carrier webhook (Sendcloud, on @astratra/payments)', () => {
  test('a signed status change reaches its handler, once; a resend is a duplicate', async () => {
    const { send, seen } = setup();
    const raw = body('Shipment picked up by driver');
    expect(await send(raw)).toEqual({ status: 200, body: { received: true, status: 'handled', type: 'parcel_status_changed' } });
    expect((await send(raw)).body.status).toBe('duplicate');
    expect(seen).toEqual([['event', 'Shipment picked up by driver'], ['picked_up', 991]]);
  });

  test('two concurrent deliveries of the same body: handled once', async () => {
    const { send, seen } = setup();
    const raw = body('Delivered');
    const results = await Promise.all([send(raw), send(raw)]);
    expect(results.map((r) => r.body.status).sort()).toEqual(['duplicate', 'handled']);
    expect(seen.filter(([kind]) => kind === 'delivered')).toHaveLength(1);
  });

  test('a wrong signature, a parsed body or an unreadable body are refused with 400 (no retry)', async () => {
    const { webhook, send, seen } = setup();
    const raw = body('Delivered');
    expect((await send(raw, sign(raw, 'other'))).status).toBe(400);
    expect((await send(raw, 'zz')).status).toBe(400);
    expect((await webhook.receive({ payload: JSON.parse(raw), headers: { 'sendcloud-signature': sign(raw) } })).status).toBe(400);
    const garbage = Buffer.from('not json');
    expect((await send(garbage)).status).toBe(400);
    expect(seen).toEqual([]);
  });

  test('an event that is not a status change is acknowledged and ignored', async () => {
    const { send, seen } = setup();
    const raw = Buffer.from(JSON.stringify({ action: 'integration_updated', integration: { id: 1 } }));
    expect(await send(raw)).toEqual({ status: 200, body: { received: true, status: 'ignored', type: 'integration_updated' } });
    expect(seen).toEqual([]);
  });

  test('a status without action (label created) only reaches onEvent', async () => {
    const { send, seen } = setup();
    expect((await send(body('Ready to send'))).body.status).toBe('handled');
    expect(seen).toEqual([['event', 'Ready to send']]);
  });

  test('a failing handler answers 500 and frees the event: the resend is handled', async () => {
    let fail = true;
    const { send, seen } = setup({ onIncident: async (event) => { if (fail) throw new Error('database down'); seen.push(['incident', event.trackingNumber]); } });
    const raw = body('Returned to sender');
    expect((await send(raw)).status).toBe(500);
    fail = false;
    expect((await send(raw)).body.status).toBe('handled');
    expect(seen.filter(([kind]) => kind === 'incident')).toEqual([['incident', '6A123']]);
  });

  test('without a secret key every event is refused; the carrier is required', async () => {
    const webhook = createCarrierWebhook({ carrier: createSendcloudCarrier({ publicKey: 'p', secretKey: '' }) });
    const raw = body('Delivered');
    expect((await webhook.receive({ payload: raw, headers: { 'sendcloud-signature': sign(raw) } })).status).toBe(400);
    expect(() => createCarrierWebhook({})).toThrow(TypeError);
  });
});

describe('webhook signature key and event order', () => {
  test('a dedicated webhook signature key is used when given; the timestamp is passed on', async () => {
    const withKey = createSendcloudCarrier({ publicKey: 'p', secretKey: 'api-secret', webhookSecret: () => 'webhook-key', sender: { addressId: 1, country: 'FR' } });
    const received = [];
    const webhook = createCarrierWebhook({ carrier: withKey, onEvent: async (event) => { received.push(event.timestamp); } });
    const raw = body('Delivered');
    expect((await webhook.receive({ payload: raw, headers: { 'sendcloud-signature': sign(raw, 'api-secret') } })).status).toBe(400);
    expect((await webhook.receive({ payload: raw, headers: { 'sendcloud-signature': sign(raw, 'webhook-key') } })).status).toBe(200);
    expect(received).toEqual([1760000000000]);
  });
});

describe('event times and event log pruning (1.1.0)', () => {
  const { toMilliseconds } = require('../src/sendcloud');

  test('readEvent always gives milliseconds, whatever unit Sendcloud sends', () => {
    const at = (timestamp) => carrier.readEvent({ action: 'parcel_status_changed', timestamp, parcel: { id: 1, status: { message: 'Delivered' } } }).timestamp;
    expect(at(1760000000)).toBe(1760000000000);
    expect(at(1760000000.5)).toBe(1760000000500);
    expect(at(1760000000123)).toBe(1760000000123);
    expect(at('1760000000')).toBe(1760000000000);
    expect(at('2026-10-17T12:00:00Z')).toBe(Date.parse('2026-10-17T12:00:00Z'));
    expect(at(undefined)).toBeNull();
    expect(at('nonsense')).toBeNull();
    expect(toMilliseconds(0)).toBeNull();
  });

  test('handled events older than pruneOlderThanMs are pruned, at most once per pruneEveryMs, off the answer path', async () => {
    let now = Date.parse('2026-10-17T10:00:00Z');
    const prunes = [];
    const eventLog = { ...createMemoryEventLog(), prune: async (olderThan) => { prunes.push(olderThan); return 0; } };
    const webhook = createCarrierWebhook({ carrier, eventLog, now: () => now, pruneOlderThanMs: 30 * 24 * 3600_000 });
    const send = async (raw) => { const answer = await webhook.receive({ payload: raw, headers: { 'sendcloud-signature': sign(raw) } }); await webhook.settled(); return answer; };
    await send(body('Delivered', { timestamp: 1 }));
    await send(body('Delivered', { timestamp: 2 }));
    expect(prunes).toEqual([30 * 24 * 3600_000]);
    now += 24 * 3600_000;
    await send(body('Delivered', { timestamp: 3 }));
    expect(prunes).toHaveLength(2);
  });

  test('pruneOlderThanMs: false disables it; a failing prune never fails the webhook', async () => {
    const calls = [];
    const off = createCarrierWebhook({ carrier, eventLog: { ...createMemoryEventLog(), prune: async () => { calls.push('off'); } }, pruneOlderThanMs: false });
    const raw = body('Delivered');
    await off.receive({ payload: raw, headers: { 'sendcloud-signature': sign(raw) } });
    await off.settled();
    expect(calls).toEqual([]);
    const warnings = [];
    const broken = createCarrierWebhook({
      carrier, logger: { warn: (m) => warnings.push(m), info() {}, error() {} },
      eventLog: { ...createMemoryEventLog(), prune: async () => { throw new Error('database down'); } }
    });
    const answer = await broken.receive({ payload: raw, headers: { 'sendcloud-signature': sign(raw) } });
    await broken.settled();
    expect(answer.status).toBe(200);
    expect(warnings.join(' ')).toMatch(/prune failed/);
  });
});
