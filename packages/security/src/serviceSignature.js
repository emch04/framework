/**
 * Proving a request came from your own service.
 *
 * The front door is guarded — sessions, tokens, CORS. The corridors between
 * your own services usually are not: one of them calls another over the network
 * and the callee trusts whatever arrives, because "it's internal". It is
 * internal right up until something else reaches that port.
 *
 * A shared secret and an HMAC settle it: the caller signs what it sends, the
 * callee checks the signature, and a forged or altered payload is refused.
 */
const crypto = require('crypto');
const { stableStringify } = require('./stableStringify');

const DEFAULT_ALGORITHM = 'sha256';

/** Compare without leaking, through timing, how much of the value was right. */
function sameSignature(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * @param {object} options
 * @param {string} options.secret  shared by the services that trust each other.
 * @param {string} [options.algorithm] default 'sha256'.
 * @param {number} [options.maxAgeMs]  how long a signature stays valid.
 *   Without it a captured payload works forever — an attacker who sees ONE
 *   signed internal call can replay it whenever they like. Set it.
 * @param {Function} [options.now]
 */
function createServiceSigner(options = {}) {
  const secret = options.secret;
  if (!secret || typeof secret !== 'string') {
    throw new Error('createServiceSigner requires options.secret as a non-empty string.');
  }

  const algorithm = options.algorithm || DEFAULT_ALGORITHM;
  const maxAgeMs = options.maxAgeMs === undefined ? null : options.maxAgeMs;
  const now = options.now || (() => Date.now());

  const digest = (payload) => crypto.createHmac(algorithm, secret).update(payload).digest('hex');

  /**
   * Sign a value. Objects are serialised with sorted keys so the two ends
   * agree whatever order they built their fields in.
   *
   * @returns {{payload: string, signature: string, issuedAt: number}}
   */
  function sign(value) {
    const issuedAt = now();
    /* The timestamp is INSIDE the signed string. Sent alongside it, an
       attacker would simply rewrite it. */
    const payload = stableStringify({ v: value, t: issuedAt });
    return { payload, signature: digest(payload), issuedAt };
  }

  /**
   * Check a signature and give back what was signed.
   *
   * @returns {{valid: boolean, value?: *, reason?: "missing"|"bad-signature"|"expired"|"malformed"}}
   */
  function verify(payload, signature) {
    if (!payload || !signature) return { valid: false, reason: 'missing' };

    /* Signature FIRST, parse second. Parsing an unverified payload runs your
       JSON parser on whatever an attacker sent. */
    if (!sameSignature(digest(payload), signature)) return { valid: false, reason: 'bad-signature' };

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { valid: false, reason: 'malformed' };
    }

    if (maxAgeMs !== null) {
      const age = now() - Number(parsed.t);
      /* A negative age means a clock ahead of ours, or a forged timestamp.
         Either way it is not something to accept. */
      if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return { valid: false, reason: 'expired' };
    }

    return { valid: true, value: parsed.v, issuedAt: parsed.t };
  }

  /**
   * The same thing shaped as headers, for the common case of one HTTP service
   * calling another.
   */
  function headers(value, names = {}) {
    const { payload, signature } = sign(value);
    return {
      [names.payload || 'x-service-payload']: Buffer.from(payload, 'utf8').toString('base64'),
      [names.signature || 'x-service-signature']: signature
    };
  }

  function verifyHeaders(requestHeaders = {}, names = {}) {
    const encoded = requestHeaders[names.payload || 'x-service-payload'];
    const signature = requestHeaders[names.signature || 'x-service-signature'];
    if (!encoded || !signature) return { valid: false, reason: 'missing' };
    let payload;
    try {
      payload = Buffer.from(String(encoded), 'base64').toString('utf8');
    } catch {
      return { valid: false, reason: 'malformed' };
    }
    return verify(payload, signature);
  }

  return { sign, verify, headers, verifyHeaders };
}

module.exports = { createServiceSigner };
