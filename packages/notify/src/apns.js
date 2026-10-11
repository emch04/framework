const { createPrivateKey, sign } = require('crypto');
const http2 = require('http2');

/**
 * Apple Push Notification service (APNs), straight from Apple: HTTP/2 and a
 * provider token signed ES256 with the team's .p8 key. No SDK, no relay.
 *
 * It is a TRANSPORT for createPushSender: `transport(deviceToken, payload)`
 * throws on failure with `statusCode` on the error, and a dead device (410,
 * BadDeviceToken, Unregistered) throws 410 so createPushSender's default
 * `isGone` hands it back for pruning.
 *
 * What it gets right, each one a lesson:
 *  - the provider token is reused for 50 minutes (Apple refuses one older than
 *    an hour, and throttles providers that sign a new one per request);
 *  - ONE HTTP/2 connection is kept and reused (Apple asks providers to keep it
 *    open); a closed or broken connection is opened again on the next send;
 *  - the key is parsed once, at creation: a malformed key fails loudly at
 *    startup, not at the first alert of the night.
 */

const JWT_TTL_MS = 50 * 60_000;
const PRODUCTION_URL = 'https://api.push.apple.com';
const SANDBOX_URL = 'https://api.sandbox.push.apple.com';
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
const DEAD_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

function apnsError(message, statusCode, reason) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (reason) error.reason = reason;
  return error;
}

/**
 * The .p8 key as Apple delivers it, or a single line where the newlines became
 * spaces or literal "\n" (how keys often come back from a vault or a .env).
 */
function normalizeKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('createApnsTransport requires options.key (the .p8 private key).');
  const body = key.replace(/\\n/g, '\n').replace(/-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** The APNs body: the alert in `aps`, your own data beside it. */
function apnsBody(payload) {
  const p = payload || {};
  const aps = {};
  if (p.title !== undefined || p.body !== undefined) aps.alert = { ...(p.title !== undefined ? { title: p.title } : {}), ...(p.body !== undefined ? { body: p.body } : {}) };
  if (p.sound !== null) aps.sound = p.sound ?? 'default';
  if (Number.isInteger(p.badge) && p.badge >= 0) aps.badge = p.badge;
  if (p.urgent) aps['interruption-level'] = 'time-sensitive';
  if (p.contentAvailable) aps['content-available'] = 1;
  if (p.threadId) aps['thread-id'] = String(p.threadId);
  return JSON.stringify({ ...(p.data || {}), aps });
}

/**
 * @param {object} options
 * @param {string} options.key       The .p8 private key (PEM, or one line).
 * @param {string} options.keyId     The key's ID (10 characters, from Apple).
 * @param {string} options.teamId    The Apple team ID.
 * @param {string} options.topic     The app's bundle identifier.
 * @param {boolean} [options.production=true] Production or sandbox gateway.
 * @param {string} [options.url]     Override the gateway (tests).
 * @param {number} [options.timeoutMs=20000]
 * @param {Function} [options.now]   Clock, for tests.
 */
function createApnsTransport(options = {}) {
  const { keyId, teamId, topic } = options;
  for (const [name, value] of Object.entries({ keyId, teamId, topic })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`createApnsTransport requires options.${name}.`);
  }
  const privateKey = createPrivateKey(normalizeKey(options.key));
  if (privateKey.asymmetricKeyType !== 'ec') throw new Error('createApnsTransport options.key must be an EC (P-256) .p8 key.');
  const url = options.url || (options.production === false ? SANDBOX_URL : PRODUCTION_URL);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = options.now || Date.now;

  let token = null;
  function providerToken() {
    if (token && now() - token.at < JWT_TTL_MS) return token.value;
    const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const head = `${b64({ alg: 'ES256', kid: keyId })}.${b64({ iss: teamId, iat: Math.floor(now() / 1000) })}`;
    const signature = sign('sha256', Buffer.from(head), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    token = { value: `${head}.${signature}`, at: now() };
    return token.value;
  }

  let session = null;
  function connection() {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(url);
    session.on('error', () => { /* surfaced on the request; the next send reconnects */ });
    session.on('goaway', () => { session.close(); });
    session.unref?.();
    return session;
  }

  async function transport(subscription, payload) {
    const deviceToken = typeof subscription === 'string' ? subscription : subscription?.token;
    if (typeof deviceToken !== 'string' || !DEVICE_TOKEN.test(deviceToken)) throw apnsError('APNs: malformed device token.', 410, 'BadDeviceToken');
    const p = payload || {};
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': p.pushType === 'voip' ? `${topic}.voip` : topic,
      'apns-push-type': p.pushType || (p.contentAvailable && p.title === undefined && p.body === undefined ? 'background' : 'alert'),
      'apns-priority': p.contentAvailable && p.title === undefined ? '5' : '10',
      'content-type': 'application/json',
      ...(p.collapseId ? { 'apns-collapse-id': String(p.collapseId).slice(0, 64) } : {}),
      ...(Number.isInteger(p.expiration) ? { 'apns-expiration': String(p.expiration) } : {})
    };
    const { status, text } = await new Promise((resolve, reject) => {
      let req;
      try { req = connection().request(headers); } catch (error) { reject(error); return; }
      let statusCode = 0;
      let body = '';
      req.setEncoding('utf8');
      req.setTimeout(timeoutMs, () => { req.close(http2.constants.NGHTTP2_CANCEL); reject(apnsError(`APNs: no answer after ${timeoutMs} ms.`, 0)); });
      req.on('response', (h) => { statusCode = Number(h[':status']); });
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => resolve({ status: statusCode, text: body }));
      req.on('error', reject);
      req.end(apnsBody(p));
    });
    if (status === 200) return { status: 200 };
    let reason = '';
    try { reason = JSON.parse(text).reason || ''; } catch { /* empty body */ }
    /* A provider token Apple calls expired or invalid is dropped, so the next send signs a fresh one. */
    if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') token = null;
    if (status === 410 || DEAD_REASONS.has(reason)) throw apnsError(`APNs: device gone (${reason || status}).`, 410, reason || 'Unregistered');
    throw apnsError(`APNs answered ${status}${reason ? ` ${reason}` : ''}.`, status, reason || undefined);
  }

  /** Closes the kept HTTP/2 connection (at shutdown). */
  transport.close = () => { if (session && !session.closed) session.close(); session = null; };
  return transport;
}

module.exports = { createApnsTransport, apnsBody };
