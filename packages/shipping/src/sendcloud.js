/**
 * Sendcloud (carrier aggregator), REST API v2: shipping_methods, parcels,
 * labels, service points.
 *
 * - Keys come from options (a value, or a function read on every call so they
 *   can be rotated or arrive after start-up). Never read from a file or the
 *   environment here, never put in an error.
 * - Calls go through a circuit breaker; only READS are retried: creating a
 *   parcel twice would buy two labels.
 * - A 4xx is Sendcloud refusing the request, not an outage: only network
 *   failures and 5xx count against the breaker and deserve a retry.
 * - Test mode replaces the chosen method by Sendcloud's "Unstamped letter",
 *   found by name (its id differs between accounts and must not be stored).
 *
 * Sendcloud puts API v2 in maintenance and recommends v3 to new users; this
 * adapter targets v2 (the one running in production today).
 */
const { createHmac, timingSafeEqual } = require('node:crypto');
const { URLSearchParams } = require('node:url');
const { createCircuitBreaker, retry, createCache } = require('@astratra/resilience');
const { Carrier } = require('./carrier');
const { CODES, ShippingError } = require('./errors');
const { classifySendcloudStatus } = require('./statuses');

const SENDCLOUD_API_URL = 'https://panel.sendcloud.sc/api/v2';
const SENDCLOUD_SERVICE_POINTS_URL = 'https://servicepoints.sendcloud.sc/api/v2/service-points';
const DEFAULT_TIMEOUT_MS = 20_000;

const read = async (value) => String((typeof value === 'function' ? await value() : value) ?? '').trim();
const isOutage = (error) => !error || error.providerStatus === undefined || error.providerStatus >= 500;
const kilograms = (grams) => (grams / 1000).toFixed(3);
const asKilograms = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};
const country = (value) => String(value ?? '').trim().toUpperCase();

/** Any failure turned into a ShippingError; `whenRefused` says what a 4xx means for this call. */
function toShippingError(error, whenRefused) {
  if (error instanceof ShippingError && error.code !== CODES.REJECTED) return error;
  const status = error && error.providerStatus;
  if (status === 401 || status === 403) return new ShippingError(CODES.CREDENTIALS_REFUSED, { providerStatus: status });
  if (status !== undefined && status < 500) return new ShippingError(whenRefused, { providerStatus: status });
  return new ShippingError(CODES.UNAVAILABLE, status === undefined ? {} : { providerStatus: status });
}

class SendcloudCarrier extends Carrier {
  /**
   * @param {object} options
   * @param {string|Function} options.publicKey
   * @param {string|Function} options.secretKey also signs the webhooks
   * @param {Function} [options.fetch] injectable (tests)
   * @param {string} [options.baseUrl]
   * @param {string} [options.servicePointsUrl]
   * @param {number} [options.timeoutMs] default 20 000
   * @param {object} [options.retry] options of @astratra/resilience retry (tests: { baseDelayMs: 0 })
   * @param {object} [options.breaker] options of createCircuitBreaker
   * @param {boolean} [options.testMode] labels on Sendcloud's "Unstamped letter": nothing is posted
   * @param {number|false} [options.servicePointsCacheSeconds] default 120; false disables the cache
   */
  constructor(options = {}) {
    super();
    this.publicKey = options.publicKey;
    this.secretKey = options.secretKey;
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.baseUrl = options.baseUrl || SENDCLOUD_API_URL;
    this.servicePointsUrl = options.servicePointsUrl || SENDCLOUD_SERVICE_POINTS_URL;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.retryOptions = options.retry || {};
    this.testMode = Boolean(options.testMode);
    this.breaker = createCircuitBreaker({
      name: 'sendcloud', failureThreshold: 5, recoveryMs: 30_000, ...options.breaker, isFailure: isOutage
    });
    const seconds = options.servicePointsCacheSeconds === undefined ? 120 : options.servicePointsCacheSeconds;
    this.cacheSeconds = seconds;
    this.cache = seconds ? createCache({ ttlSeconds: seconds, prefix: 'sendcloud:service-points:', maxEntries: 1000 }) : null;
  }

  get name() { return 'sendcloud'; }

  /** { configured, missing } — names of the missing options, never a value. */
  async status() {
    const missing = [];
    if (!(await read(this.publicKey))) missing.push('publicKey');
    if (!(await read(this.secretKey))) missing.push('secretKey');
    return { configured: missing.length === 0, missing, testMode: this.testMode };
  }

  async #keys() {
    const publicKey = await read(this.publicKey);
    const secretKey = await read(this.secretKey);
    if (!publicKey || !secretKey) throw new ShippingError(CODES.NOT_CONFIGURED);
    return { publicKey, secretKey };
  }

  /** One HTTP call; retried only when `retryable` (reads). Returns the response when ok. */
  async #call(path, { method = 'GET', body, retryable = false, url } = {}) {
    const { publicKey, secretKey } = await this.#keys();
    const headers = {
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      Accept: 'application/json'
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const once = async () => {
      let response;
      try {
        response = await this.fetchImpl(url || `${this.baseUrl}${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: globalThis.AbortSignal.timeout(this.timeoutMs)
        });
      } catch {
        /* Network failure or timeout: no HTTP status, an outage. */
        throw new ShippingError(CODES.UNAVAILABLE);
      }
      if (!response.ok) {
        const error = new ShippingError(CODES.REJECTED, { providerStatus: response.status });
        throw error;
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
   * Methods for a country and a weight. With `servicePointId`, only methods delivering to a service
   * point; without, only home delivery. `priceCents` is Sendcloud's indicative price, never recomputed.
   */
  async shippingMethods({ country: to, weightGrams, servicePointId = null } = {}) {
    const destination = country(to);
    if (!/^[A-Z]{2}$/.test(destination) || !(Number.isFinite(weightGrams) && weightGrams > 0)) {
      throw new ShippingError(CODES.INVALID_INPUT);
    }
    const methods = await this.#methods(destination, servicePointId);
    const kilos = weightGrams / 1000;
    return methods
      .filter((m) => {
        if (servicePointId ? m.service_point_input !== 'required' : m.service_point_input === 'required') return false;
        const min = asKilograms(m.min_weight);
        const max = asKilograms(m.max_weight);
        if (min !== null && kilos < min) return false;
        if (max !== null && kilos > max) return false;
        if (Array.isArray(m.countries) && m.countries.length) {
          return m.countries.some((c) => country(c.iso_2) === destination);
        }
        return true;
      })
      .map((m) => {
        const price = Number.parseFloat(m.countries?.find((c) => country(c.iso_2) === destination)?.price ?? m.price);
        return {
          id: m.id,
          name: String(m.name ?? ''),
          carrier: String(m.carrier ?? ''),
          servicePointRequired: m.service_point_input === 'required',
          priceCents: Number.isFinite(price) ? Math.round(price * 100) : null
        };
      });
  }

  async #methods(destination, servicePointId) {
    const query = `?to_country=${encodeURIComponent(destination)}&is_return=false${servicePointId ? `&service_point_id=${encodeURIComponent(servicePointId)}` : ''}`;
    let response;
    try {
      response = await this.#call(`/shipping_methods${query}`, { retryable: true });
    } catch (error) {
      throw toShippingError(error, CODES.NO_METHOD);
    }
    const data = await response.json().catch(() => ({}));
    return Array.isArray(data.shipping_methods) ? data.shipping_methods : [];
  }

  /** Sendcloud's free test method ("Unstamped letter"), looked up by name for this destination. */
  async #testMethod(destination) {
    const letter = (await this.#methods(destination, null))
      .find((m) => String(m.carrier ?? '').toLowerCase() === 'sendcloud' && /unstamped letter/i.test(String(m.name ?? '')));
    if (!letter) throw new ShippingError(CODES.NO_METHOD);
    return { id: letter.id, name: String(letter.name), carrier: 'sendcloud' };
  }

  /**
   * Creates the parcel with its label. NEVER retried: a second attempt would buy a second label.
   * recipient: { name, line1, line2?, city, postalCode, country, phone?, email? }
   * method: { id, name?, carrier? } (from shippingMethods)
   */
  async createLabel({ orderNumber, recipient = {}, weightGrams, method, servicePointId = null } = {}) {
    const destination = country(recipient.country);
    if (!recipient.name || !recipient.line1 || !recipient.city || !recipient.postalCode || !/^[A-Z]{2}$/.test(destination)
      || !(Number.isFinite(weightGrams) && weightGrams > 0) || !method || method.id === undefined || !orderNumber) {
      throw new ShippingError(CODES.INVALID_INPUT);
    }
    const chosen = this.testMode ? await this.#testMethod(destination) : method;
    const parcel = {
      name: recipient.name,
      address: recipient.line1,
      address_2: recipient.line2 || undefined,
      city: recipient.city,
      postal_code: recipient.postalCode,
      country: destination,
      telephone: recipient.phone || undefined,
      email: recipient.email || undefined,
      weight: kilograms(weightGrams),
      order_number: String(orderNumber),
      request_label: true,
      shipment: { id: chosen.id },
      ...(servicePointId && !this.testMode ? { to_service_point: servicePointId } : {})
    };
    let response;
    try {
      response = await this.#call('/parcels', { method: 'POST', body: { parcel } });
    } catch (error) {
      throw toShippingError(error, CODES.REJECTED);
    }
    const created = (await response.json().catch(() => ({}))).parcel;
    if (!created || !created.id) throw new ShippingError(CODES.UNEXPECTED_RESPONSE);
    return {
      parcelId: Number(created.id),
      trackingNumber: String(created.tracking_number ?? ''),
      trackingUrl: String(created.tracking_url ?? ''),
      carrier: chosen.carrier || String(created.carrier?.code ?? ''),
      service: chosen.name || String(created.shipment?.name ?? ''),
      testMode: this.testMode
    };
  }

  /** The label PDF; addresses built here (never taken from a response): the keys only go to Sendcloud. */
  async downloadLabel({ parcelId, format = 'a4', startFrom = 0 } = {}) {
    const id = Number(parcelId);
    if (!Number.isSafeInteger(id) || id <= 0 || !['a4', 'a6'].includes(format)) throw new ShippingError(CODES.INVALID_INPUT);
    const path = format === 'a6'
      ? `/labels/label_printer/${id}`
      : `/labels/normal_printer/${id}?start_from=${Number(startFrom) || 0}`;
    let response;
    try {
      response = await this.#call(path, { retryable: true });
    } catch (error) {
      throw toShippingError(error, CODES.NOT_FOUND);
    }
    const type = response.headers.get('content-type') || '';
    const content = Buffer.from(await response.arrayBuffer());
    if (!type.includes('pdf') || content.length === 0) throw new ShippingError(CODES.UNEXPECTED_RESPONSE);
    return { content, type: 'application/pdf' };
  }

  /** 'queued' at Sendcloud means the carrier may still refuse: { status: 'requested' }. A 410 is already cancelled. */
  async cancelLabel({ parcelId } = {}) {
    const id = Number(parcelId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ShippingError(CODES.INVALID_INPUT);
    try {
      const response = await this.#call(`/parcels/${id}/cancel`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      return { status: data.status === 'queued' ? 'requested' : 'cancelled' };
    } catch (error) {
      if (error && error.providerStatus === 410) return { status: 'cancelled' };
      throw toShippingError(error, CODES.CANCEL_REFUSED);
    }
  }

  /**
   * Service points near a postal code / city, or coordinates, nearest first.
   * carriers: Sendcloud carrier codes (for example ['mondial_relay', 'colissimo']); all when omitted.
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
    const params = new URLSearchParams({
      country: pays,
      ...(wanted ? { carrier: wanted.join(',') } : {}),
      ...(byCoordinates
        ? { latitude: String(latitude), longitude: String(longitude) }
        : { address: [postalCode, city].filter(Boolean).join(' ') }),
      radius: String(Math.max(1, Math.round(radiusMeters)))
    });
    const fetchPoints = async () => {
      let response;
      try {
        response = await this.#call('', { url: `${this.servicePointsUrl}?${params}`, retryable: true });
      } catch (error) {
        throw toShippingError(error, CODES.SERVICE_POINTS_UNAVAILABLE);
      }
      const data = await response.json().catch(() => []);
      return Array.isArray(data) ? data : (data.service_points ?? []);
    };
    const raw = this.cache ? await this.cache.remember(params.toString(), fetchPoints) : await fetchPoints();
    const carrierCode = (p) => String(p.carrier ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return raw
      .filter((p) => country(p.country) === pays && (!wanted || wanted.includes(carrierCode(p))))
      .map((p) => ({
        id: Number(p.id),
        carrier: carrierCode(p),
        name: String(p.name ?? ''),
        address: [p.street ?? p.address, p.house_number].filter(Boolean).join(' '),
        postalCode: String(p.postal_code ?? ''),
        city: String(p.city ?? ''),
        country: pays,
        openingTimes: p.formatted_opening_times ?? {},
        distanceMeters: Number.isFinite(Number(p.distance)) ? Number(p.distance) : null
      }))
      .filter((p) => Number.isSafeInteger(p.id) && p.id > 0 && p.name && p.address && p.postalCode && p.city)
      .sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity))
      .slice(0, Math.max(1, limit));
  }

  /** HMAC-SHA256 of the raw body with the secret key, compared in constant time. */
  async verifySignature(rawBody, signature) {
    const secretKey = await read(this.secretKey);
    if (!secretKey || typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) return false;
    const expected = createHmac('sha256', secretKey).update(rawBody).digest();
    const received = Buffer.from(signature.trim().toLowerCase(), 'hex');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  /** parcel_status_changed only; anything else is null (acknowledged, nothing to do). */
  readEvent(json) {
    if (!json || json.action !== 'parcel_status_changed' || !json.parcel || !json.parcel.id) return null;
    const message = String(json.parcel.status?.message ?? '');
    return {
      parcelId: Number(json.parcel.id),
      trackingNumber: String(json.parcel.tracking_number ?? ''),
      trackingUrl: String(json.parcel.tracking_url ?? ''),
      message,
      stage: classifySendcloudStatus(message)
    };
  }
}

function createSendcloudCarrier(options) {
  return new SendcloudCarrier(options);
}

module.exports = { SendcloudCarrier, createSendcloudCarrier, SENDCLOUD_API_URL, SENDCLOUD_SERVICE_POINTS_URL };
