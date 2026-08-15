export class ApiError extends Error {
  constructor(message, { status, data, error } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.error = error;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_CSRF_COOKIE_NAME = 'astratra_csrf';
const DEFAULT_CSRF_HEADER_NAME = 'x-csrf-token';

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function readCookie(name) {
  if (typeof document === 'undefined' || !document.cookie) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createApiFetch({
  baseUrl = '',
  onUnauthorized,
  fetchImpl = globalThis.fetch,
  csrf = true,
  csrfCookieName = DEFAULT_CSRF_COOKIE_NAME,
  csrfHeaderName = DEFAULT_CSRF_HEADER_NAME
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('createApiFetch requires a fetch implementation.');
  }

  return async function apiFetch(path, { method = 'GET', headers, body, ...options } = {}) {
    const upperMethod = String(method).toUpperCase();
    const requestHeaders = new Headers(headers);
    if (body !== undefined && !requestHeaders.has('content-type')) {
      requestHeaders.set('content-type', 'application/json');
    }

    // `credentials: 'include'` below already carries the session cookie —
    // a mutating request also needs the matching CSRF token attached by
    // hand, or @astratra/security's double-submit check rejects it with a
    // 403 that looks identical to a real CSRF attack being blocked.
    // Never overrides a header the caller set explicitly.
    if (csrf && !SAFE_METHODS.has(upperMethod) && !requestHeaders.has(csrfHeaderName)) {
      const token = readCookie(csrfCookieName);
      if (token) requestHeaders.set(csrfHeaderName, token);
    }

    const response = await fetchImpl(joinUrl(baseUrl, path), {
      ...options,
      method,
      headers: requestHeaders,
      credentials: 'include',
      body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body)
    });
    const payload = await readPayload(response);

    if (response.status === 401 && typeof onUnauthorized === 'function') {
      onUnauthorized();
    }

    if (!response.ok || payload?.success === false) {
      throw new ApiError(payload?.message || payload?.error || `Request failed with status ${response.status}.`, {
        status: response.status,
        data: payload?.data ?? payload,
        error: payload?.error
      });
    }

    return payload?.data ?? payload;
  };
}
