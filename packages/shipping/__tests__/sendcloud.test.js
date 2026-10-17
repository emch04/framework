const { createSendcloudCarrier, ShippingError, CODES, messageFor, classifySendcloudStatus, Carrier, TEST_SHIPPING_OPTION } = require('../src');

/** A fake Sendcloud API v3: routes answered from a table, every call recorded. No network. */
function fakeSendcloud(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url: String(url), method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    for (const [match, answer] of routes) {
      if (String(url).includes(match) && (!answer.method || answer.method === method)) {
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
    throw new Error(`unexpected route ${method} ${url}`);
  };
  return { fetch, calls };
}

const API = 'https://panel.sendcloud.sc/api/v3';
const SENDER = { addressId: 12, country: 'FR' };
const KEYS = { publicKey: 'pub_test', secretKey: 'sec_test', sender: SENDER };
const OPTIONS = {
  data: [
    { code: 'colissimo:home/signature', name: 'Colissimo Home', carrier: { code: 'colissimo' }, functionalities: { last_mile: 'home_delivery' }, quotes: [{ price: { total: { value: '7.90', currency: 'EUR' } } }] },
    { code: 'mondial_relay:point', name: 'Mondial Relay Point', carrier: { code: 'mondial_relay' }, functionalities: { last_mile: 'service_point' }, quotes: [{ price: { total: { value: '4.50', currency: 'EUR' } } }] },
    { code: 'dpd:locker', name: 'DPD Locker', carrier: { code: 'dpd' }, functionalities: { last_mile: 'locker_or_service_point' }, quotes: [] }
  ],
  message: null
};
const RECIPIENT = { name: 'Awa Diallo', line1: '12 rue des Lilas', city: 'Lyon', postalCode: '69003', country: 'fr', email: 'awa@example.test' };
const SHIPMENT = (extra = {}) => ({
  data: {
    id: 'shp_123', carrier: { code: 'colissimo' }, ship_with: { type: 'shipping_option_code', properties: { shipping_option_code: 'colissimo:home/signature' } },
    parcels: [{ id: 991, tracking_number: '6A123', tracking_url: 'https://track.test/6A123', status: { code: 'READY_TO_SEND', message: 'Ready to send' }, label_file: Buffer.from('%PDF-1.4 inline').toString('base64') }],
    errors: [],
    ...extra
  }
});
const fast = { retry: { baseDelayMs: 0, sleep: async () => {} }, servicePointsCacheSeconds: false };

describe('Sendcloud carrier (API v3)', () => {
  test('is a Carrier and says what is missing, never a value', async () => {
    const carrier = createSendcloudCarrier({ publicKey: 'pub', secretKey: '' });
    expect(carrier).toBeInstanceOf(Carrier);
    expect(carrier.name).toBe('sendcloud');
    expect(await carrier.status()).toEqual({ configured: false, missing: ['secretKey', 'sender'], testMode: false });
    expect((await createSendcloudCarrier(KEYS).status()).configured).toBe(true);
    await expect(carrier.shippingMethods({ country: 'FR', weightGrams: 500 })).rejects.toMatchObject({ code: CODES.NOT_CONFIGURED, status: 503 });
  });

  test('keys may be functions, read on every call (rotation without restart)', async () => {
    let secret = 'first';
    const { fetch, calls } = fakeSendcloud([['/shipping-options', { reply: { json: OPTIONS } }]]);
    const carrier = createSendcloudCarrier({ publicKey: async () => 'pub', secretKey: () => secret, sender: SENDER, fetch, ...fast });
    await carrier.shippingMethods({ country: 'FR', weightGrams: 500 });
    secret = 'second';
    await carrier.shippingMethods({ country: 'FR', weightGrams: 500 });
    const auth = calls.map((c) => Buffer.from(c.headers.Authorization.replace('Basic ', ''), 'base64').toString());
    expect(auth).toEqual(['pub:first', 'pub:second']);
  });

  test('shipping options: POST with sender and destination, home vs service point, quote in cents', async () => {
    const { fetch, calls } = fakeSendcloud([['/shipping-options', { method: 'POST', reply: { json: OPTIONS } }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast });
    const home = await carrier.shippingMethods({ country: 'fr', postalCode: '69003', weightGrams: 1250 });
    expect(home).toEqual([{ id: 'colissimo:home/signature', name: 'Colissimo Home', carrier: 'colissimo', servicePointRequired: false, priceCents: 790 }]);
    expect(calls[0].url).toBe(`${API}/shipping-options`);
    expect(calls[0].body).toEqual({
      from_address: { country_code: 'FR' }, to_address: { country_code: 'FR', postal_code: '69003' },
      parcels: [{ weight: { value: '1.250', unit: 'kg' } }], calculate_quotes: true
    });
    const point = await carrier.shippingMethods({ country: 'FR', weightGrams: 500, servicePointId: 42 });
    expect(point.map((m) => [m.id, m.priceCents])).toEqual([['mondial_relay:point', 450], ['dpd:locker', null]]);
    expect(calls[1].body.to_service_point).toEqual({ id: '42' });
    await expect(carrier.shippingMethods({ country: 'France', weightGrams: 500 })).rejects.toMatchObject({ code: CODES.INVALID_INPUT });
  });

  test('reads are retried after an outage; a 4xx is an answer, not retried, its body never kept', async () => {
    let n = 0;
    const { fetch, calls } = fakeSendcloud([['/shipping-options', { reply: () => (++n < 3 ? { status: 503, json: {} } : { json: OPTIONS }) }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast });
    expect((await carrier.shippingMethods({ country: 'FR', weightGrams: 500 })).length).toBe(1);
    expect(calls).toHaveLength(3);

    const refused = fakeSendcloud([['/shipping-options', { reply: { status: 400, json: { errors: [{ detail: 'secret details' }] } } }]]);
    const error = await createSendcloudCarrier({ ...KEYS, fetch: refused.fetch, ...fast }).shippingMethods({ country: 'FR', weightGrams: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(ShippingError);
    expect([error.code, error.providerStatus]).toEqual([CODES.NO_METHOD, 400]);
    expect(JSON.stringify(error)).not.toContain('secret details');
    expect(refused.calls).toHaveLength(1);
  });

  test('refused keys and network failures have their own codes, without the keys', async () => {
    const denied = fakeSendcloud([['/shipping-options', { reply: { status: 401, json: {} } }]]);
    const a = await createSendcloudCarrier({ ...KEYS, fetch: denied.fetch, ...fast }).shippingMethods({ country: 'FR', weightGrams: 1 }).catch((e) => e);
    expect(a.code).toBe(CODES.CREDENTIALS_REFUSED);
    const down = fakeSendcloud([['/shipping-options', { throws: true }]]);
    const b = await createSendcloudCarrier({ ...KEYS, fetch: down.fetch, ...fast }).shippingMethods({ country: 'FR', weightGrams: 1 }).catch((e) => e);
    expect(b.code).toBe(CODES.UNAVAILABLE);
    expect(down.calls).toHaveLength(3);
    for (const e of [a, b]) expect(`${e.message} ${JSON.stringify(e)}`).not.toMatch(/sec_test|pub_test/);
  });

  test('the circuit opens after repeated outages and answers "unavailable" without calling', async () => {
    const down = fakeSendcloud([['/shipments/announce', { throws: true }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch: down.fetch, ...fast, breaker: { failureThreshold: 2 } });
    const label = () => carrier.createLabel({ orderNumber: 'R-1', recipient: RECIPIENT, weightGrams: 500, method: { id: 'colissimo:home/signature' } }).catch((e) => e.code);
    expect(await label()).toBe(CODES.UNAVAILABLE);
    expect(await label()).toBe(CODES.UNAVAILABLE);
    const before = down.calls.length;
    expect(await label()).toBe(CODES.UNAVAILABLE);
    expect(down.calls.length).toBe(before);
  });

  test('createLabel announces once (never retried) and returns tracking and the label inline', async () => {
    const { fetch, calls } = fakeSendcloud([['/shipments/announce', { method: 'POST', reply: { status: 201, json: SHIPMENT() } }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast });
    const label = await carrier.createLabel({
      orderNumber: 'R-1', reference: 'order-R-1', recipient: RECIPIENT, weightGrams: 1250, method: { id: 'mondial_relay:point' }, servicePointId: 77
    });
    expect(label).toMatchObject({ shipmentId: 'shp_123', parcelId: 991, trackingNumber: '6A123', trackingUrl: 'https://track.test/6A123', carrier: 'colissimo', alreadyExisted: false, testMode: false });
    expect(label.label.toString()).toBe('%PDF-1.4 inline');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      from_address: { sender_address_id: 12 },
      to_address: { name: 'Awa Diallo', address_line_1: '12 rue des Lilas', postal_code: '69003', city: 'Lyon', country_code: 'FR', email: 'awa@example.test' },
      ship_with: { type: 'shipping_option_code', properties: { shipping_option_code: 'mondial_relay:point' } },
      parcels: [{ weight: { value: '1.250', unit: 'kg' } }],
      order_number: 'R-1', external_reference_id: 'order-R-1', to_service_point: { id: '77' }
    });

    const outage = fakeSendcloud([['/shipments/announce', { reply: { status: 502, json: {} } }]]);
    const once = createSendcloudCarrier({ ...KEYS, fetch: outage.fetch, ...fast });
    await expect(once.createLabel({ orderNumber: 'R-2', recipient: RECIPIENT, weightGrams: 500, method: { id: 'x' } })).rejects.toMatchObject({ code: CODES.UNAVAILABLE });
    expect(outage.calls).toHaveLength(1);
    await expect(once.createLabel({ orderNumber: 'R-3', recipient: { ...RECIPIENT, city: '' }, weightGrams: 500, method: { id: 'x' } })).rejects.toMatchObject({ code: CODES.INVALID_INPUT });
  });

  test('the same reference again: Sendcloud answers 409 with the first shipment, no second label', async () => {
    const { fetch } = fakeSendcloud([['/shipments/announce', { reply: { status: 409, json: SHIPMENT() } }]]);
    const label = await createSendcloudCarrier({ ...KEYS, fetch, ...fast }).createLabel({ orderNumber: 'R-1', reference: 'order-R-1', recipient: RECIPIENT, weightGrams: 500, method: { id: 'x' } });
    expect([label.shipmentId, label.alreadyExisted]).toEqual(['shp_123', true]);
    /* Without a reference, a 409 stays a refusal. */
    await expect(createSendcloudCarrier({ ...KEYS, fetch, ...fast }).createLabel({ orderNumber: 'R-1', recipient: RECIPIENT, weightGrams: 500, method: { id: 'x' } }))
      .rejects.toMatchObject({ code: CODES.REJECTED, providerStatus: 409 });
  });

  test('a carrier refusal comes back as 201 with errors: it is a rejection', async () => {
    const failed = SHIPMENT({ errors: [{ code: 'parcel_announcement_error', detail: 'Invalid postal code' }] });
    failed.data.parcels[0].status = { code: 'ANNOUNCEMENT_FAILED', message: 'Announcement failed' };
    const { fetch } = fakeSendcloud([['/shipments/announce', { reply: { status: 201, json: failed } }]]);
    const error = await createSendcloudCarrier({ ...KEYS, fetch, ...fast }).createLabel({ orderNumber: 'R', recipient: RECIPIENT, weightGrams: 500, method: { id: 'x' } }).catch((e) => e);
    expect(error.code).toBe(CODES.REJECTED);
    expect(JSON.stringify(error)).not.toContain('Invalid postal code');
  });

  test('test mode ships with "sendcloud:letter", ignores the service point and the chosen option', async () => {
    const { fetch, calls } = fakeSendcloud([['/shipments/announce', { reply: { status: 201, json: SHIPMENT({ ship_with: { properties: { shipping_option_code: TEST_SHIPPING_OPTION } } }) } }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast, testMode: true });
    const label = await carrier.createLabel({ orderNumber: 'R-T', recipient: RECIPIENT, weightGrams: 300, method: { id: 'colissimo:home/signature' }, servicePointId: 77 });
    expect(TEST_SHIPPING_OPTION).toBe('sendcloud:letter');
    expect([label.testMode, label.service]).toEqual([true, 'sendcloud:letter']);
    expect(calls[0].body.ship_with.properties.shipping_option_code).toBe('sendcloud:letter');
    expect(calls[0].body.to_service_point).toBeUndefined();
  });

  test('a full sender address is sent as from_address; without sender, labels are not configured', async () => {
    const { fetch, calls } = fakeSendcloud([['/shipments/announce', { reply: { status: 201, json: SHIPMENT() } }]]);
    const sender = { name: 'Boutique', line1: '1 rue du Port', city: 'Marseille', postalCode: '13002', country: 'fr' };
    await createSendcloudCarrier({ publicKey: 'p', secretKey: 's', sender, fetch, ...fast }).createLabel({ orderNumber: 'R', recipient: RECIPIENT, weightGrams: 500, method: { id: 'x' } });
    expect(calls[0].body.from_address).toEqual({ name: 'Boutique', address_line_1: '1 rue du Port', postal_code: '13002', city: 'Marseille', country_code: 'FR' });
    await expect(createSendcloudCarrier({ publicKey: 'p', secretKey: 's', fetch, ...fast }).createLabel({ orderNumber: 'R', recipient: RECIPIENT, weightGrams: 500, method: { id: 'x' } }))
      .rejects.toMatchObject({ code: CODES.NOT_CONFIGURED });
  });

  test('downloadLabel: GET the label document as PDF, A4/A5/A6; missing is not_found', async () => {
    const { fetch, calls } = fakeSendcloud([['/documents/label', { reply: { pdf: '%PDF-1.4 test' } }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, ...fast });
    const a4 = await carrier.downloadLabel({ parcelId: 991, format: 'a4' });
    expect([a4.type, a4.content.toString()]).toEqual(['application/pdf', '%PDF-1.4 test']);
    await carrier.downloadLabel({ parcelId: 991 });
    expect(calls.map((c) => c.url)).toEqual([`${API}/parcels/991/documents/label?paper_size=A4`, `${API}/parcels/991/documents/label?paper_size=A6`]);
    expect(calls[0].headers.Accept).toBe('application/pdf');
    const gone = fakeSendcloud([['/documents/label', { reply: { status: 404, json: {} } }]]);
    await expect(createSendcloudCarrier({ ...KEYS, fetch: gone.fetch, ...fast }).downloadLabel({ parcelId: 1 })).rejects.toMatchObject({ code: CODES.NOT_FOUND });
    await expect(carrier.downloadLabel({ parcelId: '../../x' })).rejects.toMatchObject({ code: CODES.INVALID_INPUT });
  });

  test('cancelLabel on the shipment: 200 cancelled, 202 requested, 409 already cancelling = cancelled, other 409 refused', async () => {
    const answer = (status, json) => fakeSendcloud([['/cancel', { method: 'POST', reply: { status, json } }]]);
    const cancel = (fake) => createSendcloudCarrier({ ...KEYS, fetch: fake.fetch, ...fast }).cancelLabel({ shipmentId: 'shp_123' });
    const ok = answer(200, { data: { status: 'cancelled' } });
    expect(await cancel(ok)).toEqual({ status: 'cancelled' });
    expect(ok.calls[0].url).toBe(`${API}/shipments/shp_123/cancel`);
    expect(await cancel(answer(202, { data: { status: 'queued' } }))).toEqual({ status: 'requested' });
    expect(await cancel(answer(409, { errors: [{ status: '409', code: 'invalid', detail: 'This shipment is already being cancelled.' }] }))).toEqual({ status: 'cancelled' });
    await expect(cancel(answer(409, { errors: [{ status: '409', code: 'invalid', detail: 'Shipment is delivered.' }] }))).rejects.toMatchObject({ code: CODES.CANCEL_REFUSED, status: 409 });
    await expect(cancel(answer(404, { errors: [] }))).rejects.toMatchObject({ code: CODES.NOT_FOUND });
    await expect(createSendcloudCarrier(KEYS).cancelLabel({ shipmentId: '../x' })).rejects.toMatchObject({ code: CODES.INVALID_INPUT });
  });

  test('service points: chosen carriers or the integration ones, nearest first, invalid entries dropped, cached', async () => {
    const point = (id, carrier, distance, extra = {}) => ({
      id, name: `Point ${id}`, carrier: { code: carrier }, distance,
      address: { street: 'Quai', house_number: String(id), postal_code: '13002', city: 'Marseille', country_code: 'FR' }, opening_times: { monday: [] }, ...extra
    });
    const results = [
      point(10, 'mondial_relay', 900), point(11, 'colissimo', 300), point(13, 'mondial_relay', 50),
      point(12, 'mondial_relay', 100, { address: { street: 'Rue', postal_code: '1000', city: 'Bruxelles', country_code: 'BE' } }),
      point(0, 'mondial_relay', 10)
    ];
    const { fetch, calls } = fakeSendcloud([['/service-points', { reply: { json: { data: { results, geocoding: { status: 'ok' } } } } }]]);
    const carrier = createSendcloudCarrier({ ...KEYS, fetch, retry: { baseDelayMs: 0 } });
    const mr = await carrier.servicePoints({ country: 'fr', postalCode: '13002', carriers: ['mondial_relay'] });
    expect(mr.map((p) => p.id)).toEqual([13, 10]);
    expect(mr[1]).toMatchObject({ carrier: 'mondial_relay', address: 'Quai 10', postalCode: '13002', city: 'Marseille', country: 'FR', distanceMeters: 900 });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v3/service-points');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ country_code: 'FR', carrier_code: 'mondial_relay', address_postal_code: '13002', radius: '10000', limit: '15' });
    await carrier.servicePoints({ country: 'FR', postalCode: '13002', carriers: ['mondial_relay'] });
    expect(calls).toHaveLength(1);
    const all = await carrier.servicePoints({ country: 'FR', latitude: 43.3, longitude: 5.37, limit: 2 });
    expect(all.map((p) => p.id)).toEqual([13, 11]);
    expect(new URL(calls[1].url).searchParams.get('use_integration_carriers')).toBe('true');
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
