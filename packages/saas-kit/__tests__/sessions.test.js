const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable, Writable } = require('node:stream');
const { createSaasApp, createMemoryUsersStore } = require('../src');

const TEST_SECRET = 'saas-kit-test-secret';

function request(app, method, url, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = {
    host: 'localhost',
    ...(body ? {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
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
      // A real http.ServerResponse emits 'finish' once the response is sent —
      // this override replaces res.end() entirely, so it has to emit it too,
      // or anything listening for 'finish' (createSecurityAuditLogger) never fires.
      res.emit('finish');
      resolve({ status: res.statusCode, headers: responseHeaders, body: parsedBody });
    };

    app.handle(req, res, reject);
  });
}

function appWith(options = {}) {
  return createSaasApp({
    jwtSecret: TEST_SECRET,
    notify: async () => ({ queued: true }),
    verifyPassword: async (user, password) => user.password === password,
    loginRateLimit: { max: 100 },
    apiRateLimit: { max: 100 },
    ...options
  });
}

async function signIn(app) {
  const response = await request(app, 'POST', '/auth/login', {
    body: { email: 'owner@example.test', password: 'password' }
  });
  assert.equal(response.status, 200);
  return response.body.data;
}

/* ─────────────────────────── Refresh ─────────────────────────── */

test('refresh is off by default: login hands back no refresh token', async () => {
  const app = appWith();

  const session = await signIn(app);

  assert.equal(session.refreshToken, undefined);
});

test('refresh route does not exist while the feature is off', async () => {
  const app = appWith();

  const response = await request(app, 'POST', '/auth/refresh', { body: { refreshToken: 'x' } });

  assert.equal(response.status, 404);
});

test('with refresh enabled, login hands back a refresh token', async () => {
  const app = appWith({ refreshTokens: { enabled: true } });

  const session = await signIn(app);

  assert.equal(typeof session.refreshToken, 'string');
  /* Hex, deliberately: a base64url token can contain '--', which the WAF reads
     as an SQL comment and blocks — that session could then never be renewed. */
  assert.match(session.refreshToken, /^[0-9a-f]{64}$/);
});

test('a reset link is hex too, for the same reason', async () => {
  const sent = [];
  const app = appWith({
    passwordReset: { send: async (payload) => { sent.push(payload); } },
    hashPassword: async (password) => `hashed:${password}`
  });

  await request(app, 'POST', '/auth/forgot-password', { body: { email: 'owner@example.test' } });

  assert.match(sent[0].token, /^[0-9a-f]{64}$/);
});

test('a refresh returns a NEW access token and a NEW refresh token', async () => {
  const app = appWith({ refreshTokens: { enabled: true } });
  const session = await signIn(app);

  const response = await request(app, 'POST', '/auth/refresh', {
    body: { refreshToken: session.refreshToken }
  });

  assert.equal(response.status, 200);
  assert.equal(typeof response.body.data.token, 'string');
  assert.notEqual(response.body.data.refreshToken, session.refreshToken);
  assert.equal(response.body.data.user.email, 'owner@example.test');
});

test('the refreshed access token actually works', async () => {
  const app = appWith({ refreshTokens: { enabled: true } });
  const session = await signIn(app);
  const refreshed = await request(app, 'POST', '/auth/refresh', {
    body: { refreshToken: session.refreshToken }
  });

  const me = await request(app, 'GET', '/auth/me', { token: refreshed.body.data.token });

  assert.equal(me.status, 200);
});

test('a spent refresh token is refused', async () => {
  const app = appWith({ refreshTokens: { enabled: true } });
  const session = await signIn(app);
  await request(app, 'POST', '/auth/refresh', { body: { refreshToken: session.refreshToken } });

  const replay = await request(app, 'POST', '/auth/refresh', {
    body: { refreshToken: session.refreshToken }
  });

  assert.equal(replay.status, 401);
});

test('replaying a spent token kills the live one too', async () => {
  const app = appWith({ refreshTokens: { enabled: true } });
  const session = await signIn(app);
  const second = await request(app, 'POST', '/auth/refresh', {
    body: { refreshToken: session.refreshToken }
  });
  assert.equal(second.status, 200, `first refresh failed: ${second.status} ${JSON.stringify(second.body)} token=${session.refreshToken}`);

  await request(app, 'POST', '/auth/refresh', { body: { refreshToken: session.refreshToken } });
  const afterTheft = await request(app, 'POST', '/auth/refresh', {
    body: { refreshToken: second.body.data.refreshToken }
  });

  assert.equal(afterTheft.status, 401);
});

test('a missing or unknown refresh token is a 401, never a crash', async () => {
  const app = appWith({ refreshTokens: { enabled: true } });

  assert.equal((await request(app, 'POST', '/auth/refresh', { body: {} })).status, 401);
  assert.equal((await request(app, 'POST', '/auth/refresh', { body: { refreshToken: 'nope' } })).status, 401);
});

test('signing out revokes the refresh token as well as the access token', async () => {
  const app = appWith({ refreshTokens: { enabled: true } });
  const session = await signIn(app);

  await request(app, 'POST', '/auth/logout', { token: session.token });
  const response = await request(app, 'POST', '/auth/refresh', {
    body: { refreshToken: session.refreshToken }
  });

  assert.equal(response.status, 401);
});

/* ───────────────────── Forgot and reset password ───────────────────── */

test('the reset routes do not exist without a way to send the mail', async () => {
  const app = appWith();

  const response = await request(app, 'POST', '/auth/forgot-password', {
    body: { email: 'owner@example.test' }
  });

  assert.equal(response.status, 404);
});

test('forgot-password sends a link and answers 200', async () => {
  const sent = [];
  const app = appWith({
    passwordReset: { send: async (payload) => { sent.push(payload); } },
    hashPassword: async (password) => `hashed:${password}`
  });

  const response = await request(app, 'POST', '/auth/forgot-password', {
    body: { email: 'owner@example.test' }
  });

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].user.email, 'owner@example.test');
  assert.equal(typeof sent[0].token, 'string');
});

test('AN UNKNOWN ADDRESS GETS THE SAME ANSWER — the screen is not a directory', async () => {
  const sent = [];
  const app = appWith({
    passwordReset: { send: async (payload) => { sent.push(payload); } },
    hashPassword: async (password) => `hashed:${password}`
  });

  const known = await request(app, 'POST', '/auth/forgot-password', { body: { email: 'owner@example.test' } });
  const unknown = await request(app, 'POST', '/auth/forgot-password', { body: { email: 'ghost@example.test' } });

  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.body.message, unknown.body.message);
  assert.equal(sent.length, 1);
});

test('a reset token sets the new password and can only be used once', async () => {
  const sent = [];
  const users = createMemoryUsersStore();
  const app = appWith({
    usersStore: users,
    passwordReset: { send: async (payload) => { sent.push(payload); } },
    hashPassword: async (password) => `hashed:${password}`
  });
  await request(app, 'POST', '/auth/forgot-password', { body: { email: 'owner@example.test' } });

  const first = await request(app, 'POST', '/auth/reset-password', {
    body: { token: sent[0].token, password: 'BrandNew1!' }
  });
  const second = await request(app, 'POST', '/auth/reset-password', {
    body: { token: sent[0].token, password: 'Another1!' }
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 400);
  const user = await users.findByEmail('owner@example.test');
  assert.equal(user.password, 'hashed:BrandNew1!');
});

test('CHANGING THE PASSWORD SIGNS EVERY DEVICE OUT', async () => {
  const sent = [];
  const app = appWith({
    refreshTokens: { enabled: true },
    passwordReset: { send: async (payload) => { sent.push(payload); } },
    hashPassword: async (password) => `hashed:${password}`
  });
  const session = await signIn(app);
  await request(app, 'POST', '/auth/forgot-password', { body: { email: 'owner@example.test' } });

  const reset = await request(app, 'POST', '/auth/reset-password', {
    body: { token: sent[0].token, password: 'BrandNew1!' }
  });
  assert.equal(reset.status, 200, `reset failed: ${JSON.stringify(reset.body)}`);

  const refresh = await request(app, 'POST', '/auth/refresh', {
    body: { refreshToken: session.refreshToken }
  });
  assert.equal(refresh.status, 401);
});

test('an unknown reset token is refused', async () => {
  const app = appWith({
    passwordReset: { send: async () => {} },
    hashPassword: async (password) => `hashed:${password}`
  });

  const response = await request(app, 'POST', '/auth/reset-password', {
    body: { token: 'nope', password: 'BrandNew1!' }
  });

  assert.equal(response.status, 400);
});

/* ────────────────────────── Push devices ────────────────────────── */

test('a phone registers itself, is listed, and unregisters', async () => {
  const app = appWith();
  const session = await signIn(app);
  const registration = { installationId: 'inst-1', pushToken: 'ExponentPushToken[x]', platform: 'ios' };

  const created = await request(app, 'POST', '/notifications/devices', {
    token: session.token,
    body: registration
  });
  const current = await request(app, 'GET', '/notifications/devices/inst-1', { token: session.token });
  const removed = await request(app, 'DELETE', '/notifications/devices/inst-1', { token: session.token });
  const afterwards = await request(app, 'GET', '/notifications/devices/inst-1', { token: session.token });

  assert.equal(created.status, 200);
  assert.deepEqual(created.body.data, { registered: true, enabled: true });
  assert.equal(current.body.data.registered, true);
  assert.equal(removed.status, 200);
  assert.equal(afterwards.body.data.registered, false);
});

test('registering the same installation twice updates it instead of duplicating', async () => {
  const app = appWith();
  const session = await signIn(app);
  const registration = { installationId: 'inst-1', pushToken: 'token-a', platform: 'ios' };

  await request(app, 'POST', '/notifications/devices', { token: session.token, body: registration });
  await request(app, 'POST', '/notifications/devices', {
    token: session.token,
    body: { ...registration, pushToken: 'token-b' }
  });
  const list = await request(app, 'GET', '/notifications/devices', { token: session.token });

  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].pushToken, 'token-b');
});

test('ONE PERSON CANNOT TOUCH ANOTHER PERSON\'S DEVICE', async () => {
  const app = appWith();
  const owner = await signIn(app);
  const member = (await request(app, 'POST', '/auth/login', {
    body: { email: 'member@example.test', password: 'password' }
  })).body.data;

  await request(app, 'POST', '/notifications/devices', {
    token: owner.token,
    body: { installationId: 'inst-1', pushToken: 'token-a', platform: 'ios' }
  });
  const stolen = await request(app, 'GET', '/notifications/devices/inst-1', { token: member.token });
  const deleted = await request(app, 'DELETE', '/notifications/devices/inst-1', { token: member.token });
  const stillThere = await request(app, 'GET', '/notifications/devices/inst-1', { token: owner.token });

  assert.equal(stolen.body.data.registered, false);
  assert.equal(deleted.status, 404);
  assert.equal(stillThere.body.data.registered, true);
});

test('registering a device requires a session', async () => {
  const app = appWith();

  const response = await request(app, 'POST', '/notifications/devices', {
    body: { installationId: 'inst-1', pushToken: 'token-a', platform: 'ios' }
  });

  assert.equal(response.status, 401);
});

test('a registration without its identifiers is refused', async () => {
  const app = appWith();
  const session = await signIn(app);

  const response = await request(app, 'POST', '/notifications/devices', {
    token: session.token,
    body: { platform: 'ios' }
  });

  assert.equal(response.status, 400);
});
