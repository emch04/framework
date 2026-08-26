/**
 * Talking to the API from a phone.
 *
 * The transport itself is unremarkable — fetch, a bearer token, a JSON
 * envelope. What is worth writing once is the handful of things a mobile
 * client gets wrong.
 *
 * THE REFRESH IS NOT REDONE HERE. Five requests fail together when a token
 * dies, five refreshes race, and four of them spend a rotated refresh token —
 * signing the person out at the exact moment everything was recoverable.
 * `@astratra/client` already solves that, single-flight and replay-once
 * included; this module wires the mobile pieces into it instead of writing a
 * fourth version of the same bug. The three call shapes below share ONE
 * refresh: a JSON call and a download racing the same dead token must not
 * renew twice.
 *
 * THE LANGUAGE IS READ PER CALL, NEVER CACHED. Server messages are displayed
 * as they arrive. Cache the header at construction and an app switched to
 * English keeps receiving French errors until it is restarted.
 *
 * MULTIPART MUST NOT BE GIVEN A CONTENT TYPE. Setting `application/json` on a
 * FormData body — or setting multipart by hand, without the boundary the
 * runtime generates — makes the upload fail server-side with no useful message.
 *
 * BINARY IS HANDED BACK, NOT WRITTEN. Saving to disk needs a filesystem module
 * this package refuses to import. `raw()` returns the response, already
 * checked; where the bytes go is the app's business.
 */

const { createSessionClient } = require('@astratra/client');

class ApiError extends Error {
  /**
   * @param {string} message  The server's own message, shown to the person.
   * @param {number} status
   * @param {*} [data]  Failures stay actionable: a 409 on an existing
   *   subscription carries the billing portal URL to open.
   */
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function messageOf(payload) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string' && payload.message) return payload.message;
    if (typeof payload.error === 'string' && payload.error) return payload.error;
  }
  return 'REQUEST_FAILED';
}

/**
 * @param {object} options
 * @param {string} options.baseUrl  e.g. https://api.acme.com/api
 * @param {object} options.session  A createSecureSession handle.
 * @param {Function} [options.fetch]  Defaults to the global fetch.
 * @param {Function} [options.language]  () => 'fr'. Read on every call.
 * @param {string} [options.platform='mobile']  Sent as X-Client-Platform.
 * @param {Function} [options.refresh]  async () => void. Omit it and a 401 is
 *   just an error — no refresh is invented on the app's behalf.
 * @param {string[]} [options.excluded]  Extra paths that never refresh. The
 *   login and refresh endpoints are excluded whether you list them or not.
 * @param {Function} [options.onSessionExpired]  Called once, after the session
 *   has been cleared: route to the sign-in screen from here.
 */
function createApiClient(options = {}) {
  const baseUrl = options.baseUrl;
  if (typeof baseUrl !== 'string' || !baseUrl) throw new Error('createApiClient requires options.baseUrl.');

  const session = options.session;
  if (!session || typeof session.getAccessToken !== 'function') {
    throw new Error('createApiClient requires options.session (see createSecureSession).');
  }

  const doFetch = options.fetch || (typeof fetch === 'function' ? fetch : null);
  if (typeof doFetch !== 'function') throw new Error('createApiClient requires a fetch implementation.');

  const language = typeof options.language === 'function' ? options.language : () => null;
  const platform = options.platform || 'mobile';
  const loginPath = options.loginPath || '/auth/login';
  const refreshPath = options.refreshPath || '/auth/refresh';

  /* Assets live on the ORIGIN, not under /api: the web serves /uploads on the
     same domain through a reverse proxy, a phone has no such luxury. */
  const origin = baseUrl.replace(/\/api\/?$/, '').replace(/\/$/, '');

  function resolveAssetUrl(path) {
    if (!path) return undefined;
    if (/^https?:\/\//.test(path)) return path;
    return `${origin}${String(path).startsWith('/') ? path : `/${path}`}`;
  }

  async function headersFor(init, accept) {
    const headers = new Headers(init.headers || {});
    headers.set('X-Client-Platform', platform);
    headers.set('Accept', accept);

    const lang = language();
    if (lang) headers.set('Accept-Language', lang);

    const multipart = typeof FormData !== 'undefined' && init.body instanceof FormData;
    if (init.body && !multipart && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const token = await session.getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }

  async function send(path, init, accept) {
    const headers = await headersFor(init || {}, accept);
    return doFetch(`${baseUrl}${path}`, { ...init, headers });
  }

  /** JSON call: unwraps `data`, throws ApiError on anything but 2xx. */
  async function jsonCall(path, init = {}) {
    const response = await send(path, init, 'application/json');
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(messageOf(payload), response.status, payload && payload.data);
    return payload ? payload.data : undefined;
  }

  /** Server-sent events: the response is handed over unread. */
  async function streamCall(path, init = {}) {
    const response = await send(path, init, 'text/event-stream');
    if (!response.ok) throw new ApiError('REQUEST_FAILED', response.status);
    return response;
  }

  /** Bytes: checked, then handed over for the caller to write somewhere. */
  async function rawCall(path, init = {}) {
    const response = await send(path, init, '*/*');
    if (!response.ok) throw new ApiError('REQUEST_FAILED', response.status);
    return response;
  }

  const plain = { request: jsonCall, stream: streamCall, raw: rawCall, resolveAssetUrl, ApiError };
  if (typeof options.refresh !== 'function') return plain;

  const excluded = [loginPath, refreshPath, ...(options.excluded || [])];

  /* One promise for the whole client. createSessionClient makes each shape
     single-flight on its own; sharing this makes them single-flight together. */
  let pending = null;
  function refreshOnce() {
    if (!pending) {
      pending = Promise.resolve()
        .then(() => options.refresh())
        .finally(() => { pending = null; });
    }
    return pending;
  }

  function expired(cause) {
    void session.clear();
    if (typeof options.onSessionExpired === 'function') options.onSessionExpired(cause);
  }

  function guard(call) {
    const client = createSessionClient({
      request: (path, init) => call(path, init),
      refresh: refreshOnce,
      excluded,
      isAuthError: (error) => error instanceof ApiError && error.status === 401,
      onSessionExpired: expired
    });
    return (path, init) => client.call(path, init);
  }

  return {
    request: guard(jsonCall),
    stream: guard(streamCall),
    raw: guard(rawCall),
    resolveAssetUrl,
    ApiError
  };
}

module.exports = { createApiClient, ApiError };
