const { createHmac } = require('node:crypto');
const { createMemoryEventLog } = require('@astratra/payments');
const { createSendcloudCarrier, createCarrierWebhook } = require('../src');

const SECRET = 'sec_test';
const carrier = createSendcloudCarrier({ publicKey: 'pub_test', secretKey: SECRET, fetch: async () => { throw new Error('no network in tests'); } });
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
