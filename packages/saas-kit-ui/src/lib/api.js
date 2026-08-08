const DEFAULT_API_URL = 'http://localhost:4000';

export class ApiError extends Error {
  constructor(message, { status, data, error } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.error = error;
  }
}

function joinUrl(apiUrl, path) {
  const base = String(apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('The API returned an invalid JSON response.', {
      status: response.status,
      data: text
    });
  }
}

export async function apiFetch(path, {
  apiUrl = import.meta.env?.VITE_API_URL || DEFAULT_API_URL,
  token,
  method = 'GET',
  body,
  fetcher = fetch,
  onUnauthorized
} = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetcher(joinUrl(apiUrl, path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await readPayload(response);

  if (response.status === 401 && typeof onUnauthorized === 'function') {
    onUnauthorized();
  }

  if (!response.ok || payload?.success === false) {
    throw new ApiError(payload?.message || payload?.error || `Request failed with status ${response.status}.`, {
      status: response.status,
      data: payload?.data,
      error: payload?.error
    });
  }

  return payload?.data;
}
