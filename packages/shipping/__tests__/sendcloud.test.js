const { createSendcloudCarrier, ShippingError, CODES, messageFor, classifySendcloudStatus, Carrier } = require('../src');

/** A fake Sendcloud: routes answered from a table, every call recorded. No network. */
function fakeSendcloud(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    for (const [match, answer] of routes) {
      if (String(url).includes(match) && (!answer.method || answer.method === (init.method || 'GET'))) {
        if (answer.throws) throw new Error('socket hang up');
        const next = typeof answer.reply === 'function' ? answer.reply(calls.length) : answer.reply;
        const { status = 200, json, pdf } = next;
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (name) => (name === 'content-type' ? (pdf ? 'application/pdf' : 'application/json') : null) },
          json: async () => json,
          arrayBuffer: async () => (pdf ? Buffer.from(pdf) : Buffer.alloc(0))
        };
      }
    }
    throw new Error(`unexpected route ${url}`);
  };
  return { fetch, calls };
}

const KEYS = { publicKey: 'pub_test', secretKey: 'sec_test' };
const METHODS = {
  shipping_methods: [
    { id: 1, name: 'Colissimo Home', carrier: 'colissimo', min_weight: '0.001', max_weight: '30.001', service_point_input: 'none', countries: [{ iso_2: 'FR', price: '7.90' }] },
    { id: 2, name: 'Mondial Relay Point', carrier: 'mondial_relay', min_weight: '0.001', max_weight: '20.001', service_point_input: 'required', countries: [{ iso_2: 'FR', price: '4.50' }] },
    { id: 3, name: 'Heavy only', carrier: 'dpd', min_weight: '10.000', max_weight: '30.000', service_point_input: 'none', countries: [{ iso_2: 'FR', price: '20' }] },
    { id: 8, name: 'Unstamped letter', carrier: 'sendcloud', min_weight: '0.001', max_weight: '2.001', service_point_input: 'none', countries: [{ iso_2: 'FR', price: '0' }] }
  ]
};
const RECIPIENT = { name: 'Awa Diallo', line1: '12 rue des Lilas', city: 'Lyon', postalCode: '69003', country: 'fr', email: 'awa@example.test' };
const fast = { retry: { baseDelayMs: 0, sleep: async () => {} }, servicePointsCacheSeconds: false };

describe('Sendcloud carrier', () => {
  test('is a Carrier and says what is missing, never a value', async () => {
    const carrier = createSendcloudCarrier({ publicKey: 'pub', secretKey: '' });
    expect(carrier).toBeInstanceOf(Carrier);
    expect(carrier.name).toBe('sendcloud');
    expect(await carrier.status()).toEqual({ configured: false, missing: ['secretKey'], testMode: false });
    await expect(carrier.shippingMethods({ country: 'FR', weightGrams: 500 })).rejects.toMatchObject({ code: CODES.NOT_CONFIGURED, status: 503 });
  });

  test('keys may be functions, read on every call (rotation without restart)', async () => {
    let secret = 'first';
    const { fetch, calls } = fakeSendcloud([['/shipping_methods', { reply: { json: METHODS } }]]);
    const carrier = createSendcloudCarrier({ publicKey: async () => 'pub', secretKey: () => secret, fetch, ...fast });
    await carrier.shippingMethods({ country: 'FR', weightGrams: 500 });
    secret = 'second';
    await carrier.shippingMethods({ country: 'FR', weightGrams: 500 });
    const auth = calls.map((c) => Buffer.from(c.headers.Authorization.replace('Basic ', ''), 'base64').toString());
    expect(auth).toEqual(['pub:first', 'pub:second']);
  });

  test('shipping methods: home delivery or service point, weight limits, price in cents', async () => {
    const { fetch } = fakeSendcloud([['/shipping_methods', { reply: { json: METHODS } }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast });
    const home = await carrier.shippingMethods({ country: 'fr', weightGrams: 500 });
    expect(home.map((m) => m.id)).toEqual([1, 8]);
    expect(home[0]).toEqual({ id: 1, name: 'Colissimo Home', carrier: 'colissimo', servicePointRequired: false, priceCents: 790 });
    const point = await carrier.shippingMethods({ country: 'FR', weightGrams: 500, servicePointId: 42 });
    expect(point.map((m) => m.id)).toEqual([2]);
    await expect(carrier.shippingMethods({ country: 'France', weightGrams: 500 })).rejects.toMatchObject({ code: CODES.INVALID_INPUT });
  });

  test('reads are retried after an outage; a 4xx is an answer, not retried', async () => {
    let n = 0;
    const { fetch, calls } = fakeSendcloud([['/shipping_methods', { reply: () => (++n < 3 ? { status: 503, json: {} } : { json: METHODS }) }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast });
    expect((await carrier.shippingMethods({ country: 'FR', weightGrams: 500 })).length).toBe(2);
    expect(calls).toHaveLength(3);

    const refused = fakeSendcloud([['/shipping_methods', { reply: { status: 400, json: { error: 'secret details' } } }]]);
    const strict = createSendcloudCarrier({ ...KEYS, fetch: refused.fetch, ...fast });
    const error = await strict.shippingMethods({ country: 'FR', weightGrams: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(ShippingError);
    expect(error.code).toBe(CODES.NO_METHOD);
    expect(error.providerStatus).toBe(400);
    expect(JSON.stringify(error)).not.toContain('secret details');
    expect(refused.calls).toHaveLength(1);
  });

  test('refused keys and network failures have their own codes, without the keys', async () => {
    const denied = fakeSendcloud([['/shipping_methods', { reply: { status: 401, json: {} } }]]);
    const a = await createSendcloudCarrier({ ...KEYS, fetch: denied.fetch, ...fast }).shippingMethods({ country: 'FR', weightGrams: 1 }).catch((e) => e);
    expect(a.code).toBe(CODES.CREDENTIALS_REFUSED);
    const down = fakeSendcloud([['/shipping_methods', { throws: true }]]);
    const b = await createSendcloudCarrier({ ...KEYS, fetch: down.fetch, ...fast }).shippingMethods({ country: 'FR', weightGrams: 1 }).catch((e) => e);
    expect(b.code).toBe(CODES.UNAVAILABLE);
    expect(down.calls).toHaveLength(3);
    for (const e of [a, b]) expect(`${e.message} ${JSON.stringify(e)}`).not.toMatch(/sec_test|pub_test/);
  });

  test('the circuit opens after repeated outages and answers "unavailable" without calling', async () => {
    const down = fakeSendcloud([['/parcels', { throws: true }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch: down.fetch, ...fast, breaker: { failureThreshold: 2 } });
    const label = () => carrier.createLabel({ orderNumber: 'R-1', recipient: RECIPIENT, weightGrams: 500, method: { id: 1 } }).catch((e) => e.code);
    expect(await label()).toBe(CODES.UNAVAILABLE);
    expect(await label()).toBe(CODES.UNAVAILABLE);
    const before = down.calls.length;
    expect(await label()).toBe(CODES.UNAVAILABLE);
    expect(down.calls.length).toBe(before);
  });

  test('createLabel sends the parcel once (never retried) and returns tracking', async () => {
    const { fetch, calls } = fakeSendcloud([['/parcels', { method: 'POST', reply: { json: { parcel: { id: 991, tracking_number: '6A123', tracking_url: 'https://track.test/6A123' } } } }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast });
    const label = await carrier.createLabel({ orderNumber: 'R-1', recipient: RECIPIENT, weightGrams: 1250, method: { id: 1, name: 'Colissimo Home', carrier: 'colissimo' }, servicePointId: 77 });
    expect(label).toEqual({ parcelId: 991, trackingNumber: '6A123', trackingUrl: 'https://track.test/6A123', carrier: 'colissimo', service: 'Colissimo Home', testMode: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.parcel).toMatchObject({ name: 'Awa Diallo', country: 'FR', weight: '1.250', order_number: 'R-1', request_label: true, shipment: { id: 1 }, to_service_point: 77 });

    const outage = fakeSendcloud([['/parcels', { reply: { status: 502, json: {} } }]]);
    const once = createSendcloudCarrier({ ...KEYS, fetch: outage.fetch, ...fast });
    await expect(once.createLabel({ orderNumber: 'R-2', recipient: RECIPIENT, weightGrams: 500, method: { id: 1 } })).rejects.toMatchObject({ code: CODES.UNAVAILABLE });
    expect(outage.calls).toHaveLength(1);
    await expect(once.createLabel({ orderNumber: 'R-3', recipient: { ...RECIPIENT, city: '' }, weightGrams: 500, method: { id: 1 } })).rejects.toMatchObject({ code: CODES.INVALID_INPUT });
  });

  test('test mode labels go on the "Unstamped letter", found by name (never a stored id)', async () => {
    const methods = { shipping_methods: METHODS.shipping_methods.map((m) => (m.carrier === 'sendcloud' ? { ...m, id: 5021 } : m)) };
    const { fetch, calls } = fakeSendcloud([
      ['/shipping_methods', { reply: { json: methods } }],
      ['/parcels', { method: 'POST', reply: { json: { parcel: { id: 5, tracking_number: '', tracking_url: '' } } } }]
    ]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast, testMode: true });
    const label = await carrier.createLabel({ orderNumber: 'R-T', recipient: RECIPIENT, weightGrams: 300, method: { id: 1, name: 'Colissimo Home' }, servicePointId: 77 });
    expect(label.testMode).toBe(true);
    expect(label.service).toBe('Unstamped letter');
    const sent = calls.find((c) => c.method === 'POST').body.parcel;
    expect(sent.shipment).toEqual({ id: 5021 });
    expect(sent.to_service_point).toBeUndefined();

    const none = fakeSendcloud([['/shipping_methods', { reply: { json: { shipping_methods: [] } } }]]);
    const without = createSendcloudCarrier({ ...KEYS, fetch: none.fetch, ...fast, testMode: true });
    await expect(without.createLabel({ orderNumber: 'R', recipient: RECIPIENT, weightGrams: 300, method: { id: 1 } })).rejects.toMatchObject({ code: CODES.NO_METHOD });
  });

  test('downloadLabel returns the PDF; A4 or A6; a missing label is not_found', async () => {
    const { fetch, calls } = fakeSendcloud([['/labels/', { reply: { pdf: '%PDF-1.4 test' } }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast });
    const a4 = await carrier.downloadLabel({ parcelId: 991, startFrom: 2 });
    expect(a4.type).toBe('application/pdf');
    expect(a4.content.toString()).toContain('%PDF');
    await carrier.downloadLabel({ parcelId: 991, format: 'a6' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://panel.sendcloud.sc/api/v2/labels/normal_printer/991?start_from=2',
      'https://panel.sendcloud.sc/api/v2/labels/label_printer/991'
    ]);
    const gone = fakeSendcloud([['/labels/', { reply: { status: 404, json: {} } }]]);
    await expect(createSendcloudCarrier({ ...KEYS, fetch: gone.fetch, ...fast }).downloadLabel({ parcelId: 1 })).rejects.toMatchObject({ code: CODES.NOT_FOUND });
    await expect(carrier.downloadLabel({ parcelId: '../../x' })).rejects.toMatchObject({ code: CODES.INVALID_INPUT });
  });

  test('cancelLabel: queued is "requested", 410 is already cancelled, a refusal is cancel_refused', async () => {
    const queued = fakeSendcloud([['/cancel', { reply: { json: { status: 'queued' } } }]]);
    expect(await createSendcloudCarrier({ ...KEYS, fetch: queued.fetch, ...fast }).cancelLabel({ parcelId: 9 })).toEqual({ status: 'requested' });
    const done = fakeSendcloud([['/cancel', { reply: { json: { status: 'deleted' } } }]]);
    expect(await createSendcloudCarrier({ ...KEYS, fetch: done.fetch, ...fast }).cancelLabel({ parcelId: 9 })).toEqual({ status: 'cancelled' });
    const gone = fakeSendcloud([['/cancel', { reply: { status: 410, json: {} } }]]);
    expect(await createSendcloudCarrier({ ...KEYS, fetch: gone.fetch, ...fast }).cancelLabel({ parcelId: 9 })).toEqual({ status: 'cancelled' });
    const refused = fakeSendcloud([['/cancel', { reply: { status: 400, json: {} } }]]);
    await expect(createSendcloudCarrier({ ...KEYS, fetch: refused.fetch, ...fast }).cancelLabel({ parcelId: 9 })).rejects.toMatchObject({ code: CODES.CANCEL_REFUSED, status: 409 });
  });

  test('service points: chosen carriers, nearest first, invalid entries dropped, cached', async () => {
    const points = [
      { id: 10, name: 'Tabac du Port', carrier: 'mondial_relay', street: 'Quai', house_number: '3', postal_code: '13002', city: 'Marseille', country: 'FR', distance: 900 },
      { id: 11, name: 'Bureau', carrier: 'colissimo', street: 'Rue', house_number: '1', postal_code: '13001', city: 'Marseille', country: 'FR', distance: 300 },
      { id: 12, name: 'Ailleurs', carrier: 'mondial_relay', street: 'Rue', postal_code: '1000', city: 'Bruxelles', country: 'BE', distance: 100 },
      { id: 0, name: 'Sans id', carrier: 'mondial_relay', street: 'Rue', postal_code: '13001', city: 'Marseille', country: 'FR' },
      { id: 13, name: 'Épicerie', carrier: 'Mondial Relay', street: 'Bd', postal_code: '13003', city: 'Marseille', country: 'FR', distance: 50 }
    ];
    const { fetch, calls } = fakeSendcloud([['servicepoints.sendcloud.sc', { reply: { json: points } }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, retry: { baseDelayMs: 0 } });
    const mr = await carrier.servicePoints({ country: 'fr', postalCode: '13002', carriers: ['mondial_relay'] });
    expect(mr.map((p) => p.id)).toEqual([13, 10]);
    expect(mr[1]).toMatchObject({ carrier: 'mondial_relay', address: 'Quai 3', postalCode: '13002', city: 'Marseille', country: 'FR', distanceMeters: 900 });
    expect(new URL(calls[0].url).searchParams.get('carrier')).toBe('mondial_relay');
    await carrier.servicePoints({ country: 'FR', postalCode: '13002', carriers: ['mondial_relay'] });
    expect(calls).toHaveLength(1);
    const all = await carrier.servicePoints({ country: 'FR', latitude: 43.3, longitude: 5.37, limit: 2 });
    expect(all.map((p) => p.id)).toEqual([13, 11]);
    await expect(carrier.servicePoints({ country: 'FR' })).rejects.toMatchObject({ code: CODES.INVALID_INPUT });
    await expect(carrier.servicePoints({ country: 'FR', latitude: 120, longitude: 5 })).rejects.toMatchObject({ code: CODES.INVALID_INPUT });
  });
});

describe('statuses and messages', () => {
  test('Sendcloud statuses map to the three moments a shop acts on', () => {
    expect(classifySendcloudStatus('Ready to send')).toBeNull();
    expect(classifySendcloudStatus('Announced')).toBeNull();
    expect(classifySendcloudStatus(' Shipment  picked up by driver ')).toBe('picked_up');
    expect(classifySendcloudStatus('Delivery attempt failed')).toBe('picked_up');
    expect(classifySendcloudStatus('Delivered')).toBe('delivered');
    expect(classifySendcloudStatus('Shipment collected by customer')).toBe('delivered');
    expect(classifySendcloudStatus('Returned to sender')).toBe('incident');
    expect(classifySendcloudStatus(undefined)).toBeNull();
  });

  test('every code has a French and an English sentence; unknown language falls back to French', () => {
    for (const code of Object.values(CODES)) {
      const fr = messageFor(code, 'fr');
      const en = messageFor(code, 'en');
      expect(fr).toBeTruthy();
      expect(en).toBeTruthy();
      expect(en).not.toBe(fr);
    }
    expect(messageFor(new ShippingError(CODES.NOT_CONFIGURED), 'de')).toBe(messageFor(CODES.NOT_CONFIGURED, 'fr'));
    expect(messageFor('nonsense', 'en')).toBe(messageFor(CODES.UNEXPECTED_RESPONSE, 'en'));
  });
});
