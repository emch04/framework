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
