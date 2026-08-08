import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, apiFetch } from '@astratra/saas-kit-ui/api';

test('apiFetch unwraps Astratra apiResponse data', async () => {
  const fetchCalls = [];
  const fetcher = async (url, options) => {
    fetchCalls.push({ url, options });
    return new Response(JSON.stringify({
      success: true,
      message: 'Dashboard summary',
      data: { userCount: 2 },
      timestamp: '2026-08-08T00:00:00.000Z'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const data = await apiFetch('/dashboard/summary', {
    token: 'demo-token',
    fetcher,
    apiUrl: 'http://localhost:4000'
  });

  assert.deepEqual(data, { userCount: 2 });
  assert.equal(fetchCalls[0].url, 'http://localhost:4000/dashboard/summary');
  assert.equal(fetchCalls[0].options.headers.authorization, 'Bearer demo-token');
});

test('apiFetch throws ApiError and calls onUnauthorized for 401 responses', async () => {
  let unauthorizedCalls = 0;
  const fetcher = async () => new Response(JSON.stringify({
    success: false,
    message: 'Invalid token.',
    data: null,
    timestamp: '2026-08-08T00:00:00.000Z',
    error: { code: 'UNAUTHORIZED' }
  }), { status: 401, headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    () => apiFetch('/auth/me', {
      token: 'expired',
      fetcher,
      apiUrl: 'http://localhost:4000',
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      }
    }),
    (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.equal(error.status, 401);
      assert.equal(error.message, 'Invalid token.');
      return true;
    }
  );
  assert.equal(unauthorizedCalls, 1);
});
