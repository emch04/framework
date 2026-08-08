const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable, Writable } = require('node:stream');
const jwt = require('jsonwebtoken');
const {
  createSaasApp,
  createMemorySettingsStore,
  createMemoryUsersStore
} = require('../src');

const TEST_SECRET = 'saas-kit-test-secret';

function createTestApp(options = {}) {
  const notifications = [];
  const app = createSaasApp({
    jwtSecret: TEST_SECRET,
    notify: async (userId, notification) => {
      notifications.push({ userId, notification });
      return { queued: true };
    },
    verifyPassword: async (user, password) => user.password === password,
    loginRateLimit: { max: 100 },
    apiRateLimit: { max: 100 },
    ...options
  });

  return { app, notifications };
}

async function login(app, email, password = 'password') {
  const response = await request(app, 'POST', '/auth/login', {
    body: { email, password }
  });

  assert.equal(response.status, 200);
  return response.body.data.token;
}

function request(app, method, url, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = {
    host: 'localhost',
    ...(body ? {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    } : {}),
    ...(options.headers || {})
  };

  const req = new Readable({
    read() {
      if (body) {
        this.push(body);
      }
      this.push(null);
    }
  });
  req.method = method;
  req.url = url;
  req.originalUrl = url;
  req.headers = headers;
  const socket = new PassThrough();
  socket.remoteAddress = '127.0.0.1';
  req.connection = socket;
  req.socket = socket;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const responseHeaders = {};
    const res = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });

    res.statusCode = 200;
    res.setHeader = (key, value) => {
      responseHeaders[key.toLowerCase()] = value;
    };
    res.getHeader = (key) => responseHeaders[key.toLowerCase()];
    res.getHeaders = () => responseHeaders;
    res.removeHeader = (key) => {
      delete responseHeaders[key.toLowerCase()];
    };
    res.end = (chunk) => {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsedBody = rawBody;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch (_error) {
          parsedBody = rawBody;
        }
      }
      resolve({ status: res.statusCode, headers: responseHeaders, body: parsedBody });
    };

    app.handle(req, res, reject);
  });
}

test('login returns a JWT and public user data for a valid user', async () => {
  const { app } = createTestApp();

  const response = await request(app, 'POST', '/auth/login', {
    body: { email: 'owner@example.test', password: 'password' }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.message, 'Login successful');
  assert.equal(typeof response.body.data.token, 'string');
  assert.deepEqual(response.body.data.user, {
    id: 'user-owner',
    email: 'owner@example.test',
    role: 'owner'
  });
});

test('protected routes reject missing tokens and non-admin roles', async () => {
  const { app } = createTestApp();

  const missingToken = await request(app, 'GET', '/users');
  assert.equal(missingToken.status, 401);
  assert.equal(missingToken.body.success, false);

  const memberToken = await login(app, 'member@example.test');
  const forbidden = await request(app, 'GET', '/users', {
    headers: { authorization: `Bearer ${memberToken}` }
  });

  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.success, false);
});

test('login tokens work with configured JWT issuer and audience', async () => {
  const { app } = createTestApp({
    jwtAlgorithms: ['HS256'],
    jwtIssuer: 'astratra-test',
    jwtAudience: 'astratra-api'
  });

  const token = await login(app, 'owner@example.test');
  const decoded = jwt.verify(token, TEST_SECRET, {
    algorithms: ['HS256'],
    issuer: 'astratra-test',
    audience: 'astratra-api'
  });
  const response = await request(app, 'GET', '/dashboard/summary', {
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(decoded.iss, 'astratra-test');
  assert.equal(decoded.aud, 'astratra-api');
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
});

test('users routes support basic admin CRUD through the users store', async () => {
  const { app } = createTestApp();
  const token = await login(app, 'owner@example.test');

  const created = await request(app, 'POST', '/users', {
    headers: { authorization: `Bearer ${token}` },
    body: { email: 'new@example.test', role: 'member', name: 'New User', password: 'secret' }
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.data.email, 'new@example.test');
  assert.equal(created.body.data.role, 'member');
  assert.equal(created.body.data.password, undefined);

  const listed = await request(app, 'GET', '/users?role=member&limit=10&offset=0', {
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.items.some((user) => user.email === 'new@example.test'), true);

  const fetched = await request(app, 'GET', `/users/${created.body.data.id}`, {
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.name, 'New User');

  const updated = await request(app, 'PATCH', `/users/${created.body.data.id}`, {
    headers: { authorization: `Bearer ${token}` },
    body: { name: 'Renamed User' }
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.name, 'Renamed User');
});

test('settings routes read and write generic key/value settings', async () => {
  const { app } = createTestApp();
  const token = await login(app, 'owner@example.test');

  const patched = await request(app, 'PATCH', '/settings/theme', {
    headers: { authorization: `Bearer ${token}` },
    body: { value: 'light' }
  });

  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.data, { key: 'theme', value: 'light' });

  const listed = await request(app, 'GET', '/settings', {
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.theme, 'light');
});

test('notifications route delegates delivery to the injected notify adapter', async () => {
  const { app, notifications } = createTestApp();
  const token = await login(app, 'owner@example.test');

  const response = await request(app, 'POST', '/notifications/send', {
    headers: { authorization: `Bearer ${token}` },
    body: {
      userId: 'user-member',
      title: 'Hello',
      message: 'A generic notification',
      channel: 'email'
    }
  });

  assert.equal(response.status, 200);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], {
    userId: 'user-member',
    notification: {
      title: 'Hello',
      message: 'A generic notification',
      channel: 'email'
    }
  });
});

test('dashboard summary reports generic user count and role breakdown', async () => {
  const { app } = createTestApp();
  const token = await login(app, 'owner@example.test');

  const response = await request(app, 'GET', '/dashboard/summary', {
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.userCount, 2);
  assert.deepEqual(response.body.data.roleBreakdown, {
    member: 1,
    owner: 1
  });
});

test('custom admin roles are honored without imposing fixed roles', async () => {
  const usersStore = createMemoryUsersStore({
    users: [
      { id: 'u1', email: 'lead@example.test', role: 'lead', password: 'password' },
      { id: 'u2', email: 'regular@example.test', role: 'regular', password: 'password' }
    ]
  });
  const settingsStore = createMemorySettingsStore();
  const { app } = createTestApp({
    usersStore,
    settingsStore,
    roles: { adminRoles: ['lead'] }
  });

  const leadToken = await login(app, 'lead@example.test');
  const allowed = await request(app, 'GET', '/settings', {
    headers: { authorization: `Bearer ${leadToken}` }
  });
  assert.equal(allowed.status, 200);

  const regularToken = await login(app, 'regular@example.test');
  const forbidden = await request(app, 'GET', '/settings', {
    headers: { authorization: `Bearer ${regularToken}` }
  });
  assert.equal(forbidden.status, 403);
});

test('webauthn routes are mounted only when a webauthn store is provided', async () => {
  const withoutStore = createTestApp();
  const missing = await request(withoutStore.app, 'POST', '/auth/webauthn/register/options');
  assert.equal(missing.status, 404);

  const withStore = createTestApp({ webauthnStore: {} });
  const mounted = await request(withStore.app, 'POST', '/auth/webauthn/register/options');
  assert.equal(mounted.status, 401);
});
