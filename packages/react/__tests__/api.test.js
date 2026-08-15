import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiFetch } from '../src/api.js';

test('createApiFetch sends HttpOnly cookies and unwraps Astratra data', async () => {
  let receivedUrl;
  let receivedOptions;
  const apiFetch = createApiFetch({
    baseUrl: 'https://api.example.test/',
    fetchImpl: async (url, options) => {
      receivedUrl = url;
      receivedOptions = options;
      return new Response(JSON.stringify({ success: true, data: { id: 'u1' } }), { status: 200 });
    }
  });

  const data = await apiFetch('/session', { method: 'GET' });

  assert.deepEqual(data, { id: 'u1' });
  assert.equal(receivedUrl, 'https://api.example.test/session');
  assert.equal(receivedOptions.credentials, 'include');
});

test('createApiFetch calls onUnauthorized and exposes API errors', async () => {
  let unauthorizedCalls = 0;
  const apiFetch = createApiFetch({
    fetchImpl: async () => new Response(JSON.stringify({ success: false, message: 'Session expirée.' }), { status: 401 }),
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    }
  });

  await assert.rejects(() => apiFetch('/session'), (error) => {
    assert.equal(error instanceof ApiError, true);
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Session expirée.');
    return true;
  });
  assert.equal(unauthorizedCalls, 1);
});

test('createApiFetch identifies forbidden responses', async () => {
  const apiFetch = createApiFetch({
    fetchImpl: async () => new Response(JSON.stringify({ success: false, message: 'Accès interdit.' }), { status: 403 })
  });

  await assert.rejects(() => apiFetch('/admin'), (error) => {
    assert.equal(error.status, 403);
    return true;
  });
});

test('createApiFetch attaches the CSRF header on mutating requests, from the astratra_csrf cookie', async (t) => {
  document.cookie = 'astratra_csrf=secret-token; path=/';
  t.after(() => { document.cookie = 'astratra_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; });

  let receivedHeaders;
  const apiFetch = createApiFetch({
    fetchImpl: async (_url, options) => {
      receivedHeaders = options.headers;
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
    }
  });

  await apiFetch('/orders', { method: 'POST', body: { id: 1 } });

  assert.equal(receivedHeaders.get('x-csrf-token'), 'secret-token');
});

test('createApiFetch does not attach a CSRF header on safe (GET/HEAD/OPTIONS) requests', async (t) => {
  document.cookie = 'astratra_csrf=secret-token; path=/';
  t.after(() => { document.cookie = 'astratra_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; });

  let receivedHeaders;
  const apiFetch = createApiFetch({
    fetchImpl: async (_url, options) => {
      receivedHeaders = options.headers;
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
    }
  });

  await apiFetch('/products', { method: 'GET' });

  assert.equal(receivedHeaders.has('x-csrf-token'), false);
});

test('createApiFetch never overrides an explicit CSRF header set by the caller', async (t) => {
  document.cookie = 'astratra_csrf=cookie-token; path=/';
  t.after(() => { document.cookie = 'astratra_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; });

  let receivedHeaders;
  const apiFetch = createApiFetch({
    fetchImpl: async (_url, options) => {
      receivedHeaders = options.headers;
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
    }
  });

  await apiFetch('/orders', { method: 'POST', headers: { 'x-csrf-token': 'explicit-token' }, body: {} });

  assert.equal(receivedHeaders.get('x-csrf-token'), 'explicit-token');
});

test('createApiFetch skips CSRF entirely when csrf: false', async (t) => {
  document.cookie = 'astratra_csrf=secret-token; path=/';
  t.after(() => { document.cookie = 'astratra_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; });

  let receivedHeaders;
  const apiFetch = createApiFetch({
    csrf: false,
    fetchImpl: async (_url, options) => {
      receivedHeaders = options.headers;
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
    }
  });

  await apiFetch('/orders', { method: 'POST', body: {} });

  assert.equal(receivedHeaders.has('x-csrf-token'), false);
});

test('createApiFetch respects a custom csrfCookieName / csrfHeaderName pair', async (t) => {
  document.cookie = 'custom_csrf=custom-token; path=/';
  t.after(() => { document.cookie = 'custom_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; });

  let receivedHeaders;
  const apiFetch = createApiFetch({
    csrfCookieName: 'custom_csrf',
    csrfHeaderName: 'x-custom-csrf',
    fetchImpl: async (_url, options) => {
      receivedHeaders = options.headers;
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
    }
  });

  await apiFetch('/orders', { method: 'POST', body: {} });

  assert.equal(receivedHeaders.get('x-custom-csrf'), 'custom-token');
});

test('createApiFetch sends no CSRF header when the cookie was never set (e.g. no prior safe request)', async () => {
  let receivedHeaders;
  const apiFetch = createApiFetch({
    fetchImpl: async (_url, options) => {
      receivedHeaders = options.headers;
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
    }
  });

  await apiFetch('/orders', { method: 'POST', body: {} });

  assert.equal(receivedHeaders.has('x-csrf-token'), false);
});
