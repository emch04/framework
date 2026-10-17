/**
 * Sendcloud (carrier aggregator), REST API v3: shipping options, shipments,
 * parcel documents, service points, tracking webhooks.
 *
 * - Keys come from options (a value, or a function read on every call so they
 *   can be rotated or arrive after start-up). Never read from a file or the
 *   environment here, never put in an error.
 * - Calls go through a circuit breaker; only READS are retried: announcing a
 *   shipment twice would buy two labels. With a `reference`, Sendcloud itself
 *   refuses a second shipment (409) and returns the first one.
 * - A 4xx is Sendcloud refusing the request, not an outage: only network
 *   failures and 5xx count against the breaker and deserve a retry.
 * - Test mode ships with the option code "sendcloud:letter" (unstamped letter):
 *   nothing is posted.
 *
 * References: https://sendcloud.dev (API v3: shipping-options, shipments/announce,
 * shipments/{id}/cancel, parcels/{id}/documents/label, service-points).
 */
const { createHmac, timingSafeEqual } = require('node:crypto');
const { URLSearchParams } = require('node:url');
const { createCircuitBreaker, retry, createCache } = require('@astratra/resilience');
const { Carrier } = require('./carrier');
const { CODES, ShippingError } = require('./errors');
const { classifySendcloudStatus } = require('./statuses');

const SENDCLOUD_API_URL = 'https://panel.sendcloud.sc/api/v3';
const TEST_SHIPPING_OPTION = 'sendcloud:letter';
const DEFAULT_TIMEOUT_MS = 20_000;
const SERVICE_POINT_DELIVERY = new Set(['service_point', 'locker', 'locker_or_service_point']);

const read = async (value) => String((typeof value === 'function' ? await value() : value) ?? '').trim();
const isOutage = (error) => !error || error.providerStatus === undefined || error.providerStatus >= 500;
const kilograms = (grams) => (grams / 1000).toFixed(3);
const country = (value) => String(value ?? '').trim().toUpperCase();
const cents = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** Any failure turned into a ShippingError; `whenRefused` says what a 4xx means for this call. */
function toShippingError(error, whenRefused) {
  if (error instanceof ShippingError && error.code !== CODES.REJECTED) return error;
  const status = error && error.providerStatus;
  if (status === 401 || status === 403) return new ShippingError(CODES.CREDENTIALS_REFUSED, { providerStatus: status });
  if (status !== undefined && status < 500) return new ShippingError(whenRefused, { providerStatus: status });
  return new ShippingError(CODES.UNAVAILABLE, status === undefined ? {} : { providerStatus: status });
}

/** The sender, as Sendcloud's from_address: a saved sender address id, or the full address. */
function fromAddress(sender) {
  if (!sender) return null;
  if (sender.addressId !== undefined && sender.addressId !== null) return { sender_address_id: Number(sender.addressId) };
  if (!sender.name || !sender.line1 || !sender.city || !sender.postalCode || !/^[A-Z]{2}$/.test(country(sender.country))) return null;
  return {
    name: sender.name,
    company_name: sender.companyName || undefined,
    address_line_1: sender.line1,
    address_line_2: sender.line2 || undefined,
    house_number: sender.houseNumber || undefined,
    postal_code: sender.postalCode,
    city: sender.city,
    country_code: country(sender.country),
    phone_number: sender.phone || undefined,
    email: sender.email || undefined
  };
}

class SendcloudCarrier extends Carrier {
  /**
   * @param {object} options
   * @param {string|Function} options.publicKey
   * @param {string|Function} options.secretKey
   * @param {string|Function} [options.webhookSecret] the "Webhook Signature Key" when the integration has one; else the secret key
   * @param {object} options.sender { addressId, country } (a sender address saved in Sendcloud) or { name, line1, city, postalCode, country, … }
   * @param {Function} [options.fetch] injectable (tests)
   * @param {string} [options.baseUrl]
   * @param {number} [options.timeoutMs] default 20 000
   * @param {object} [options.retry] options of @astratra/resilience retry (tests: { baseDelayMs: 0 })
   * @param {object} [options.breaker] options of createCircuitBreaker
   * @param {boolean} [options.testMode] labels on "sendcloud:letter": nothing is posted
   * @param {number|false} [options.servicePointsCacheSeconds] default 120; false disables the cache
   */
  constructor(options = {}) {
    super();
    this.publicKey = options.publicKey;
    this.secretKey = options.secretKey;
    this.webhookSecret = options.webhookSecret;
    this.sender = fromAddress(options.sender);
    /* Shipping options need the departure country, also with a saved sender address. */
    this.senderCountry = country(options.sender && options.sender.country);
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.baseUrl = options.baseUrl || SENDCLOUD_API_URL;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.retryOptions = options.retry || {};
    this.testMode = Boolean(options.testMode);
    this.breaker = createCircuitBreaker({
      name: 'sendcloud', failureThreshold: 5, recoveryMs: 30_000, ...options.breaker, isFailure: isOutage
    });
    const seconds = options.servicePointsCacheSeconds === undefined ? 120 : options.servicePointsCacheSeconds;
    this.cache = seconds ? createCache({ ttlSeconds: seconds, prefix: 'sendcloud:service-points:', maxEntries: 1000 }) : null;
  }

  get name() { return 'sendcloud'; }

  /** { configured, missing, testMode } — names of what is missing, never a value. */
  async status() {
    const missing = [];
    if (!(await read(this.publicKey))) missing.push('publicKey');
    if (!(await read(this.secretKey))) missing.push('secretKey');
    if (!this.sender || !/^[A-Z]{2}$/.test(this.senderCountry)) missing.push('sender');
    return { configured: missing.length === 0, missing, testMode: this.testMode };
  }

  async #keys() {
    const publicKey = await read(this.publicKey);
    const secretKey = await read(this.secretKey);
    if (!publicKey || !secretKey) throw new ShippingError(CODES.NOT_CONFIGURED);
    return { publicKey, secretKey };
  }

  /**
   * One HTTP call; retried only when `retryable` (reads). Returns the response when ok, or when its
   * status is listed in `accept` (for example 409 on a shipment announced again with its reference).
   */
  async #call(path, { method = 'GET', body, retryable = false, accept = [], headers: extra = {} } = {}) {
    const { publicKey, secretKey } = await this.#keys();
    const headers = {
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      Accept: 'application/json',
      ...extra
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const once = async () => {
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: globalThis.AbortSignal.timeout(this.timeoutMs)
        });
      } catch {
        /* Network failure or timeout: no HTTP status, an outage. */
        throw new ShippingError(CODES.UNAVAILABLE);
      }
      if (!response.ok && !accept.includes(response.status)) {
        throw new ShippingError(CODES.REJECTED, { providerStatus: response.status });
      }
      return response;
    };
    try {
      return await this.breaker.call(() => (retryable
        ? retry(once, { attempts: 3, ...this.retryOptions, shouldRetry: (error) => isOutage(error) })
        : once()));
    } catch (error) {
      if (error && error.code === 'CIRCUIT_OPEN') throw new ShippingError(CODES.UNAVAILABLE);
      throw error;
    }
  }

  /**
   * Shipping options for a destination and a weight (POST /shipping-options, with quotes). With
   * `servicePointId`, only service point or locker delivery; without, only the other deliveries.
   * `id` is the shipping option code; `priceCents` is Sendcloud's quote, never recomputed here.
   */
  async shippingMethods({ country: to, postalCode, weightGrams, servicePointId = null } = {}) {
    const destination = country(to);
    if (!/^[A-Z]{2}$/.test(destination) || !(Number.isFinite(weightGrams) && weightGrams > 0)) {
      throw new ShippingError(CODES.INVALID_INPUT);
    }
    if (!this.senderCountry || !/^[A-Z]{2}$/.test(this.senderCountry)) throw new ShippingError(CODES.NOT_CONFIGURED);
    const body = {
      from_address: { country_code: this.senderCountry },
      to_address: { country_code: destination, ...(postalCode ? { postal_code: String(postalCode) } : {}) },
      parcels: [{ weight: { value: kilograms(weightGrams), unit: 'kg' } }],
      calculate_quotes: true,
      ...(servicePointId ? { to_service_point: { id: String(servicePointId) } } : {})
    };
    let response;
    try {
      response = await this.#call('/shipping-options', { method: 'POST', body, retryable: true });
    } catch (error) {
      throw toShippingError(error, CODES.NO_METHOD);
    }
    const data = (await response.json().catch(() => ({}))).data;
    return (Array.isArray(data) ? data : [])
      .filter((option) => {
        const toPoint = SERVICE_POINT_DELIVERY.has(option.functionalities?.last_mile);
        return servicePointId ? toPoint : !toPoint;
      })
      .map((option) => ({
        id: String(option.code),
        name: String(option.name ?? ''),
        carrier: String(option.carrier?.code ?? ''),
        servicePointRequired: SERVICE_POINT_DELIVERY.has(option.functionalities?.last_mile),
        priceCents: cents(option.quotes?.[0]?.price?.total?.value)
      }));
  }

  /**
   * Announces the shipment and gets its label in the same answer (POST /shipments/announce).
   * NEVER retried. `reference` (optional, unique per account) makes a second announcement of the same
   * shipment return the first one instead of buying a second label.
   * recipient: { name, line1, line2?, houseNumber?, city, postalCode, country, phone?, email? }
   * method: { id } — a shipping option code from shippingMethods
   */
  async createLabel({ orderNumber, reference, recipient = {}, weightGrams, method, servicePointId = null } = {}) {
    const destination = country(recipient.country);
    const code = method && (method.code ?? method.id);
    if (!recipient.name || !recipient.line1 || !recipient.city || !recipient.postalCode || !/^[A-Z]{2}$/.test(destination)
      || !(Number.isFinite(weightGrams) && weightGrams > 0) || (!code && !this.testMode) || !orderNumber) {
      throw new ShippingError(CODES.INVALID_INPUT);
    }
    if (!this.sender) throw new ShippingError(CODES.NOT_CONFIGURED);
    const optionCode = this.testMode ? TEST_SHIPPING_OPTION : String(code);
    const body = {
      from_address: this.sender,
      to_address: {
        name: recipient.name,
        address_line_1: recipient.line1,
        address_line_2: recipient.line2 || undefined,
        house_number: recipient.houseNumber || undefined,
        postal_code: recipient.postalCode,
        city: recipient.city,
        country_code: destination,
        phone_number: recipient.phone || undefined,
        email: recipient.email || undefined
      },
      ship_with: { type: 'shipping_option_code', properties: { shipping_option_code: optionCode } },
      parcels: [{ weight: { value: kilograms(weightGrams), unit: 'kg' } }],
      order_number: String(orderNumber),
      ...(reference ? { external_reference_id: String(reference) } : {}),
      ...(servicePointId && !this.testMode ? { to_service_point: { id: String(servicePointId) } } : {})
    };
    let response;
    try {
      response = await this.#call('/shipments/announce', { method: 'POST', body, accept: reference ? [409] : [] });
    } catch (error) {
      throw toShippingError(error, CODES.REJECTED);
    }
    const shipment = (await response.json().catch(() => ({}))).data;
    const parcel = shipment && Array.isArray(shipment.parcels) ? shipment.parcels[0] : null;
    /* A carrier refusal arrives as 201 with errors and an ANNOUNCEMENT_FAILED parcel. */
    if (shipment && Array.isArray(shipment.errors) && shipment.errors.length) throw new ShippingError(CODES.REJECTED, { providerStatus: response.status });
    if (parcel && String(parcel.status?.code ?? '').toUpperCase() === 'ANNOUNCEMENT_FAILED') throw new ShippingError(CODES.REJECTED, { providerStatus: response.status });
    if (!shipment || !shipment.id || !parcel || !parcel.id) throw new ShippingError(CODES.UNEXPECTED_RESPONSE);
    return {
      shipmentId: String(shipment.id),
      parcelId: Number(parcel.id),
      trackingNumber: String(parcel.tracking_number ?? ''),
      trackingUrl: String(parcel.tracking_url ?? ''),
      carrier: String(shipment.carrier?.code ?? ''),
      service: String(shipment.ship_with?.properties?.shipping_option_code ?? optionCode),
      /* The label itself, when Sendcloud returns it inline (one parcel): no second request needed. */
      label: typeof parcel.label_file === 'string' && parcel.label_file ? Buffer.from(parcel.label_file, 'base64') : null,
      alreadyExisted: response.status === 409,
      testMode: this.testMode
    };
  }

  /** The label PDF (GET /parcels/{id}/documents/label), paper A4 or A6. */
  async downloadLabel({ parcelId, format = 'a6' } = {}) {
    const id = Number(parcelId);
    if (!Number.isSafeInteger(id) || id <= 0 || !['a4', 'a5', 'a6'].includes(format)) throw new ShippingError(CODES.INVALID_INPUT);
    let response;
    try {
      response = await this.#call(`/parcels/${id}/documents/label?paper_size=${format.toUpperCase()}`, {
        retryable: true, headers: { Accept: 'application/pdf' }
      });
    } catch (error) {
      throw toShippingError(error, CODES.NOT_FOUND);
    }
    const type = response.headers.get('content-type') || '';
    const content = Buffer.from(await response.arrayBuffer());
    if (!type.includes('pdf') || content.length === 0) throw new ShippingError(CODES.UNEXPECTED_RESPONSE);
    return { content, type: 'application/pdf' };
  }

  /**
   * Cancels a shipment (POST /shipments/{id}/cancel). 202 "queued": Sendcloud watches it and cancels
   * it if nothing moves ({ status: 'requested' }). A 409 is refused (delivered, older than 42 days),
   * except "already being cancelled", which is the wanted state.
   */
  async cancelLabel({ shipmentId } = {}) {
    const id = String(shipmentId ?? '').trim();
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ShippingError(CODES.INVALID_INPUT);
    let response;
    try {
      response = await this.#call(`/shipments/${encodeURIComponent(id)}/cancel`, { method: 'POST', accept: [409] });
    } catch (error) {
      throw toShippingError(error, error && error.providerStatus === 404 ? CODES.NOT_FOUND : CODES.CANCEL_REFUSED);
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const detail = Array.isArray(body.errors) ? body.errors.map((e) => String(e.detail ?? '')).join(' ') : '';
      if (/already/i.test(detail)) return { status: 'cancelled' };
      throw new ShippingError(CODES.CANCEL_REFUSED, { providerStatus: 409 });
    }
    return { status: response.status === 202 || body.data?.status === 'queued' ? 'requested' : 'cancelled' };
  }

  /**
   * Service points near an address or coordinates, nearest first (GET /service-points).
   * carriers: Sendcloud carrier codes (for example ['mondial_relay', 'colissimo']); without, the
   * carriers enabled on the integration.
   */
  async servicePoints({ country: of, postalCode, city, latitude, longitude, carriers, radiusMeters = 10_000, limit = 15 } = {}) {
    const pays = country(of);
    const byCoordinates = latitude !== undefined || longitude !== undefined;
    if (!/^[A-Z]{2}$/.test(pays)
      || (byCoordinates && !(Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180))
      || (!byCoordinates && !postalCode && !city)) {
      throw new ShippingError(CODES.INVALID_INPUT);
    }
    const wanted = Array.isArray(carriers) && carriers.length ? carriers.map((c) => String(c).toLowerCase()) : null;
    const params = new URLSearchParams({ country_code: pays });
    if (wanted) for (const code of wanted) params.append('carrier_code', code);
    else params.set('use_integration_carriers', 'true');
    if (byCoordinates) {
      params.set('latitude', String(latitude));
      params.set('longitude', String(longitude));
    } else {
      if (postalCode) params.set('address_postal_code', String(postalCode));
      if (city) params.set('address_city', String(city));
    }
    params.set('radius', String(Math.min(50_000, Math.max(100, Math.round(radiusMeters)))));
    params.set('limit', String(Math.min(200, Math.max(1, limit))));
    const fetchPoints = async () => {
      let response;
      try {
        response = await this.#call(`/service-points?${params}`, { retryable: true });
      } catch (error) {
        throw toShippingError(error, CODES.SERVICE_POINTS_UNAVAILABLE);
      }
      const body = await response.json().catch(() => ({}));
      return Array.isArray(body.data?.results) ? body.data.results : [];
    };
    const raw = this.cache ? await this.cache.remember(params.toString(), fetchPoints) : await fetchPoints();
    return raw
      .map((p) => ({
        id: Number(p.id),
        carrier: String(p.carrier?.code ?? '').toLowerCase(),
        name: String(p.name ?? ''),
        address: [p.address?.street, p.address?.house_number].filter(Boolean).join(' '),
        postalCode: String(p.address?.postal_code ?? ''),
        city: String(p.address?.city ?? ''),
        country: country(p.address?.country_code),
        openingTimes: p.opening_times ?? {},
        distanceMeters: Number.isFinite(Number(p.distance)) && p.distance !== null ? Number(p.distance) : null
      }))
      .filter((p) => p.country === pays && (!wanted || wanted.includes(p.carrier))
        && Number.isSafeInteger(p.id) && p.id > 0 && p.name && p.address && p.postalCode && p.city)
      .sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity))
      .slice(0, Math.max(1, limit));
  }

  /** HMAC-SHA256 of the raw body (Sendcloud-Signature header, hex), compared in constant time. */
  async verifySignature(rawBody, signature) {
    const secret = (await read(this.webhookSecret)) || (await read(this.secretKey));
    if (!secret || typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    const received = Buffer.from(signature.trim().toLowerCase(), 'hex');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  /**
   * parcel_status_changed only; anything else is null (acknowledged, nothing to do). Webhooks can
   * arrive out of order: `timestamp` says which status is the latest.
   */
  readEvent(json) {
    if (!json || json.action !== 'parcel_status_changed' || !json.parcel || !json.parcel.id) return null;
    const message = String(json.parcel.status?.message ?? '');
    const timestamp = Number(json.timestamp);
    return {
      parcelId: Number(json.parcel.id),
      trackingNumber: String(json.parcel.tracking_number ?? ''),
      trackingUrl: String(json.parcel.tracking_url ?? ''),
      message,
      stage: classifySendcloudStatus(message),
      timestamp: Number.isFinite(timestamp) ? timestamp : null
    };
  }
}

function createSendcloudCarrier(options) {
  return new SendcloudCarrier(options);
}

module.exports = { SendcloudCarrier, createSendcloudCarrier, SENDCLOUD_API_URL, TEST_SHIPPING_OPTION };
