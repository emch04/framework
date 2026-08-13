export class ApiError extends Error {
  constructor(message, { status, data, error } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.error = error;
  }
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
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

export function createApiFetch({ baseUrl = '', onUnauthorized, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('createApiFetch requires a fetch implementation.');
  }

  return async function apiFetch(path, { method = 'GET', headers, body, ...options } = {}) {
    const requestHeaders = new Headers(headers);
    if (body !== undefined && !requestHeaders.has('content-type')) {
      requestHeaders.set('content-type', 'application/json');
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
