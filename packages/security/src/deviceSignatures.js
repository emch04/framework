/**
 * Requests signed by a phone's secure chip (Secure Enclave on iPhone, StrongBox
 * on Android): an app that opens without any sign-in screen, yet answers only
 * the devices it knows.
 *
 * The phone makes a P-256 key pair INSIDE its chip; the private key never
 * leaves it. Every request carries a signature of what it says (method, path,
 * time, a nonce, a fingerprint of the body). The server keeps only the public
 * key, so a copy of its database signs nothing.
 *
 * Two keys per device:
 *  - the DEVICE key signs every request, silently;
 *  - the BIOMETRIC key is created by the app with an access control that makes
 *    the chip refuse to sign without Face ID / a fingerprint. A route that
 *    requires it gets a signature the chip produced only after a biometric
 *    check. The server verifies the key, the phone guarantees the check.
 *
 * The rules, each one enforced below:
 *  - a signature older (or further in the future) than `maxSkewMs` is refused;
 *  - a nonce is spent once (`store.spendNonce`, atomic): a captured request
 *    replayed even a second later is refused;
 *  - the body is part of what is signed: a changed byte breaks the signature;
 *  - enrolment can be capped (`maxDevices`): with 1, the first phone becomes
 *    the only one and enrolment closes for good — "the one device" pattern;
 *  - enrolment proves possession: the new keys must sign the enrolment itself;
 *  - every refusal is the SAME answer, so a prober learns nothing.
 */
const crypto = require('crypto');

const HEADER = {
  device: 'x-device-id',
  time: 'x-device-time',
  nonce: 'x-device-nonce',
  signature: 'x-device-signature',
  key: 'x-device-key'
};
/* The DER header of a P-256 SubjectPublicKeyInfo: prepended to the 65-byte raw point iOS exports. */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,128}$/;

class DeviceSignatureError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'DeviceSignatureError'; }
}

/**
 * A public key as a phone hands it over: the raw uncompressed point (65 bytes,
 * what SecKeyCopyExternalRepresentation gives), an SPKI DER, or a PEM.
 */
function importPublicKey(value) {
  if (typeof value !== 'string' || !value.trim()) throw new DeviceSignatureError('bad_key');
  let key;
  try {
    if (value.includes('BEGIN PUBLIC KEY')) key = crypto.createPublicKey(value);
    else {
      const bytes = Buffer.from(value, 'base64');
      const der = bytes.length === 65 && bytes[0] === 0x04 ? Buffer.concat([P256_SPKI_PREFIX, bytes]) : bytes;
      key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
  } catch {
    throw new DeviceSignatureError('bad_key');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new DeviceSignatureError('bad_key');
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

/** What is signed, byte for byte the same on the phone and on the server. */
function canonicalRequest({ method, path, time, nonce, body }) {
  const digest = crypto.createHash('sha256').update(body === undefined || body === null ? '' : body).digest('base64url');
  return [String(method).toUpperCase(), path, String(time), nonce, digest].join('\n');
}

/** Accepts the chip's DER (X9.62) signature, or the 64-byte raw form. */
function verifySignature(publicKeyPem, data, signatureB64) {
  let signature;
  try { signature = Buffer.from(String(signatureB64), 'base64'); } catch { return false; }
  if (!signature.length) return false;
  const dsaEncoding = signature.length === 64 ? 'ieee-p1363' : 'der';
  try {
    return crypto.verify('sha256', Buffer.from(data), { key: publicKeyPem, dsaEncoding }, signature);
  } catch {
    return false;
  }
}

/**
 * In-memory store: one process, for development and tests. In production give
 * a store backed by your database — `spendNonce` MUST be atomic (an INSERT
 * that fails on a duplicate), or two servers each accept the same replay.
 */
function createMemoryDeviceStore() {
  const devices = new Map();
  const nonces = new Map();
  return {
    async getDevice(id) { return devices.get(id) || null; },
    async countDevices() { return [...devices.values()].filter((d) => !d.revokedAt).length; },
    async addDevice(device) { if (devices.has(device.id)) return false; devices.set(device.id, { ...device }); return true; },
    async revokeDevice(id, at) { const d = devices.get(id); if (d) d.revokedAt = at; return Boolean(d); },
    async spendNonce(deviceId, nonce, expiresAt) {
      const now = Date.now();
      for (const [k, exp] of nonces) if (exp < now) nonces.delete(k);
      const key = `${deviceId}:${nonce}`;
      if (nonces.has(key)) return false;
      nonces.set(key, expiresAt);
      return true;
    }
  };
}

/**
 * @param {object} options
 * @param {object} options.store        getDevice, countDevices, addDevice, revokeDevice, spendNonce (see createMemoryDeviceStore).
 * @param {number} [options.maxSkewMs=60000]  How far a signature's time may be from the server's.
 * @param {number|null} [options.maxDevices=null]  Cap on enrolled devices (1: the one-device pattern).
 * @param {Function} [options.now]
 */
function createDeviceSignatureVerifier(options = {}) {
  const store = options.store;
  for (const method of ['getDevice', 'countDevices', 'addDevice', 'revokeDevice', 'spendNonce']) {
    if (!store || typeof store[method] !== 'function') throw new Error(`createDeviceSignatureVerifier requires options.store.${method}.`);
  }
  const maxSkewMs = options.maxSkewMs ?? 60_000;
  const maxDevices = options.maxDevices ?? null;
  const now = options.now || Date.now;

  function readHeaders(headers) {
    const get = (name) => {
      const v = headers?.[name] ?? headers?.[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    return {
      deviceId: get(HEADER.device), time: Number(get(HEADER.time)), nonce: get(HEADER.nonce),
      signature: get(HEADER.signature), keyKind: get(HEADER.key) === 'biometric' ? 'biometric' : 'device'
    };
  }

  async function checkFreshness(deviceId, time, nonce) {
    if (!Number.isFinite(time) || Math.abs(now() - time) > maxSkewMs) throw new DeviceSignatureError('stale');
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new DeviceSignatureError('bad_nonce');
    if (!(await store.spendNonce(deviceId, nonce, now() + 2 * maxSkewMs))) throw new DeviceSignatureError('replay');
  }

  /**
   * Verifies one request. Returns { device, biometric } or throws DeviceSignatureError
   * (code: unknown_device, stale, bad_nonce, replay, bad_signature, biometric_required, revoked).
   * @param {{ method: string, path: string, headers: object, body?: string|Buffer }} request  body: the RAW bytes.
   * @param {{ requireBiometric?: boolean }} [rules]
   */
  async function verify(request, rules = {}) {
    const h = readHeaders(request.headers);
    if (typeof h.deviceId !== 'string' || !DEVICE_ID.test(h.deviceId)) throw new DeviceSignatureError('unknown_device');
    const device = await store.getDevice(h.deviceId);
    if (!device) throw new DeviceSignatureError('unknown_device');
    if (device.revokedAt) throw new DeviceSignatureError('revoked');
    if (rules.requireBiometric && h.keyKind !== 'biometric') throw new DeviceSignatureError('biometric_required');
    const publicKey = h.keyKind === 'biometric' ? device.biometricPublicKey : device.publicKey;
    if (!publicKey) throw new DeviceSignatureError('biometric_required');
    const data = canonicalRequest({ method: request.method, path: request.path, time: h.time, nonce: h.nonce, body: request.body });
    if (!verifySignature(publicKey, data, h.signature)) throw new DeviceSignatureError('bad_signature');
    /* The nonce is spent only once the signature is good: a forger cannot burn a real phone's nonces. */
    await checkFreshness(h.deviceId, h.time, h.nonce);
    return { device: { id: device.id, label: device.label ?? null }, biometric: h.keyKind === 'biometric' };
  }

  /**
   * Enrols a device. The enrolment request is itself signed by the new device key
   * (and, when given, a second signature by the biometric key in `biometricSignature`):
   * proof that the caller holds both private keys.
   * @param {{ method: string, path: string, headers: object, body?: string|Buffer }} request
   * @param {{ id: string, publicKey: string, biometricPublicKey?: string, label?: string, biometricSignature?: string }} enrolment
   * @returns {Promise<{ id: string }>} or throws DeviceSignatureError (closed, exists, bad_key, bad_signature, stale, replay).
   */
  async function enroll(request, enrolment) {
    if (!enrolment || typeof enrolment.id !== 'string' || !DEVICE_ID.test(enrolment.id)) throw new DeviceSignatureError('bad_request');
    if (maxDevices !== null && (await store.countDevices()) >= maxDevices) throw new DeviceSignatureError('closed');
    const publicKey = importPublicKey(enrolment.publicKey);
    const biometricPublicKey = enrolment.biometricPublicKey ? importPublicKey(enrolment.biometricPublicKey) : null;
    const h = readHeaders(request.headers);
    if (h.deviceId !== enrolment.id) throw new DeviceSignatureError('bad_request');
    const data = canonicalRequest({ method: request.method, path: request.path, time: h.time, nonce: h.nonce, body: request.body });
    if (!verifySignature(publicKey, data, h.signature)) throw new DeviceSignatureError('bad_signature');
    if (biometricPublicKey && !verifySignature(biometricPublicKey, data, enrolment.biometricSignature)) throw new DeviceSignatureError('bad_signature');
    await checkFreshness(enrolment.id, h.time, h.nonce);
    const added = await store.addDevice({ id: enrolment.id, publicKey, biometricPublicKey, label: enrolment.label ?? null, enrolledAt: now(), revokedAt: null });
    if (!added) throw new DeviceSignatureError('exists');
    /* Two phones racing for the last place: the store let both in; the later one is undone. */
    if (maxDevices !== null && (await store.countDevices()) > maxDevices) {
      await store.revokeDevice(enrolment.id, now());
      throw new DeviceSignatureError('closed');
    }
    return { id: enrolment.id };
  }

  /** Whether a new device could still enrol. */
  async function enrollmentOpen() {
    return maxDevices === null || (await store.countDevices()) < maxDevices;
  }

  /**
   * Express middleware: sets req.device, or answers `rejectStatus` (default 401;
   * 404 to look like a service that does not exist). Needs the RAW body: mount
   * express.raw() (or keep req.rawBody) before it.
   */
  function middleware({ requireBiometric = false, rejectStatus = 401 } = {}) {
    return async (req, res, next) => {
      try {
        const body = Buffer.isBuffer(req.body) ? req.body : req.rawBody ?? (typeof req.body === 'string' ? req.body : '');
        const result = await verify({ method: req.method, path: req.originalUrl || req.url, headers: req.headers, body }, { requireBiometric });
        req.device = result.device;
        req.deviceBiometric = result.biometric;
        next();
      } catch (error) {
        if (!(error instanceof DeviceSignatureError)) return next(error);
        res.status(rejectStatus).json({ message: rejectStatus === 404 ? 'Not found.' : 'Unauthorized.' });
      }
    };
  }

  return { verify, enroll, enrollmentOpen, middleware, revoke: (id) => store.revokeDevice(id, now()) };
}

module.exports = {
  createDeviceSignatureVerifier,
  createMemoryDeviceStore,
  canonicalDeviceRequest: canonicalRequest,
  importDevicePublicKey: importPublicKey,
  DeviceSignatureError,
  DEVICE_SIGNATURE_HEADERS: HEADER
};
