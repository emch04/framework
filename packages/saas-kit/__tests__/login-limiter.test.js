const test = require('node:test');
const assert = require('node:assert/strict');
const { createSaasApp, createMemoryUsersStore } = require('../src');
const { TEST_PASSWORD_HASH, testUsers, verifyTestPassword } = require('./fixtures');

const SECRET = 'saas-kit-test-secret';

async function serve(options = {}) {
  const app = createSaasApp({
    jwtSecret: SECRET,
    notify: async () => ({ queued: true }),
    usersStore: createMemoryUsersStore({ users: testUsers() }),
    verifyPassword: verifyTestPassword,
    loginRateLimit: { max: 3 },
    apiRateLimit: { max: 1000 },
    ...options
  });
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((ok) => server.close(ok)) };
}

const post = (base, path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
});

test('/auth/me is never counted by the login limiter: an app can be opened many times', async () => {
  const { base, close } = await serve();
  try {
    const login = await post(base, '/auth/login', { email: 'owner@example.test', password: 'password' });
    assert.equal(login.status, 200);
    const { token } = (await login.json()).data;
    for (let i = 0; i < 12; i += 1) {
      const me = await fetch(base + '/auth/me', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(me.status, 200, `ouverture n°${i + 1}`);
    }
  } finally {
    await close();
  }
});

test('wrong passwords are still limited on /auth/login', async () => {
  const { base, close } = await serve();
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await post(base, '/auth/login', { email: 'owner@example.test', password: 'faux' })).status);
    }
    assert.ok(statuses.slice(0, 3).every((s) => s === 401), statuses.join(','));
    assert.equal(statuses[4], 429);
  } finally {
    await close();
  }
});

test('a skip given by the application still applies', async () => {
  const { base, close } = await serve({ loginRateLimit: { max: 1, skip: () => true } });
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await post(base, '/auth/login', { email: 'owner@example.test', password: 'faux' })).status, 401);
    }
  } finally {
    await close();
  }
});
