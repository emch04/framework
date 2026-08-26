const { createApiClient, ApiError, createSecureSession, createMemoryKeystore } = require('../src');

function harness(overrides = {}) {
  const calls = [];
  const session = createSecureSession({ keystore: createMemoryKeystore(), namespace: 'acme' });
  const responses = overrides.responses || [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const next = responses.shift();
    if (typeof next === 'function') return next();
    return next || { ok: true, status: 200, json: async () => ({ data: { ok: true } }) };
  };
  const api = createApiClient({
    baseUrl: 'https://api.acme.com/api',
    session,
    fetch: fetchImpl,
    language: () => 'fr',
    ...overrides.options
  });
  return { api, calls, session };
}

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

describe('request', () => {
  test('hits the base url and unwraps the data envelope', async () => {
    const { api, calls } = harness({ responses: [ok({ id: 'o1' })] });

    await expect(api.request('/orders/o1')).resolves.toEqual({ id: 'o1' });
    expect(calls[0].url).toBe('https://api.acme.com/api/orders/o1');
  });

  test('sends the bearer token once there is a session', async () => {
    const { api, session, calls } = harness({ responses: [ok({}), ok({})] });

    await api.request('/me');
    await session.save({ accessToken: 'a1', refreshToken: 'r1' });
    await api.request('/me');

    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[1].headers.authorization).toBe('Bearer a1');
  });

  test('the screen language rides along, read on every call', async () => {
    let language = 'fr';
    const { api, calls } = harness({
      responses: [ok({}), ok({})],
      options: { language: () => language }
    });

    await api.request('/me');
    language = 'en';
    await api.request('/me');

    expect(calls[0].headers['accept-language']).toBe('fr');
    expect(calls[1].headers['accept-language']).toBe('en');
  });

  test('a JSON body gets its content type, a multipart body does not', async () => {
    const { api, calls } = harness({ responses: [ok({}), ok({})] });

    await api.request('/orders', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    await api.request('/avatar', { method: 'POST', body: new FormData() });

    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[1].headers['content-type']).toBeUndefined();
  });

  test('an HTTP failure becomes an ApiError carrying status and payload', async () => {
    const { api } = harness({
      responses: [fail(409, { message: 'Déjà actif', data: { portalUrl: 'https://billing' } })]
    });

    await expect(api.request('/subscribe')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Déjà actif',
      data: { portalUrl: 'https://billing' }
    });
  });

  test('a body that is not JSON still yields a typed error, not a parse crash', async () => {
    const { api } = harness({ responses: [{ ok: false, status: 502, json: async () => { throw new Error('html'); } }] });

    await expect(api.request('/x')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('refresh', () => {
  test('a 401 refreshes once, then replays the request', async () => {
    const refreshed = [];
    const { api, session } = harness({
      responses: [fail(401, {}), ok({ id: 'o1' })],
      options: {
        refresh: async () => { refreshed.push('once'); await session.save({ accessToken: 'a2' }); }
      }
    });
    await session.save({ accessToken: 'a1', refreshToken: 'r1' });

    await expect(api.request('/orders/o1')).resolves.toEqual({ id: 'o1' });
    expect(refreshed).toEqual(['once']);
  });

  test('five requests racing a dead token share ONE refresh', async () => {
    let refreshes = 0;
    const responses = [fail(401, {}), fail(401, {}), fail(401, {}), ok({}), ok({}), ok({})];
    const { api, session } = harness({
      responses,
      options: {
        refresh: async () => {
          refreshes += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          await session.save({ accessToken: 'fresh' });
        }
      }
    });
    await session.save({ accessToken: 'a1', refreshToken: 'r1' });

    await Promise.all([api.request('/a'), api.request('/b'), api.request('/c')]);

    expect(refreshes).toBe(1);
  });

  test('the refresh and login paths never trigger a refresh of their own', async () => {
    let refreshes = 0;
    const { api } = harness({
      responses: [fail(401, { message: 'Mot de passe invalide.' })],
      options: { refresh: async () => { refreshes += 1; } }
    });

    await expect(api.request('/auth/login', { method: 'POST' })).rejects.toMatchObject({ status: 401 });
    expect(refreshes).toBe(0);
  });

  test('a refresh that fails clears the session and reports the expiry once', async () => {
    const expired = [];
    const { api, session } = harness({
      responses: [fail(401, {})],
      options: {
        refresh: async () => { throw new Error('refresh token rotated'); },
        onSessionExpired: () => expired.push('gone')
      }
    });
    await session.save({ accessToken: 'a1', refreshToken: 'r1' });

    await expect(api.request('/orders')).rejects.toBeTruthy();
    expect(await session.getAccessToken()).toBeNull();
    expect(expired).toEqual(['gone']);
  });

  test('with no refresh wired in, a 401 is simply an error', async () => {
    const { api } = harness({ responses: [fail(401, {})] });

    await expect(api.request('/orders')).rejects.toMatchObject({ status: 401 });
  });
});

describe('raw and stream', () => {
  test('stream asks for an event stream and hands back the response untouched', async () => {
    const response = { ok: true, status: 200, body: 'stream' };
    const { api, calls } = harness({ responses: [response] });

    await expect(api.stream('/chat', { method: 'POST' })).resolves.toBe(response);
    expect(calls[0].headers.accept).toBe('text/event-stream');
  });

  test('raw hands back the response so the caller can write it to a file', async () => {
    const response = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    const { api } = harness({ responses: [response] });

    await expect(api.raw('/documents/d1.pdf')).resolves.toBe(response);
  });

  test('a failing raw download is an ApiError, not a half-written file', async () => {
    const { api } = harness({ responses: [{ ok: false, status: 404, json: async () => ({}) }] });

    await expect(api.raw('/documents/missing.pdf')).rejects.toMatchObject({ status: 404 });
  });
});

describe('resolveAssetUrl', () => {
  test('a relative path is resolved against the origin, not against /api', () => {
    const { api } = harness();

    expect(api.resolveAssetUrl('/uploads/a.png')).toBe('https://api.acme.com/uploads/a.png');
    expect(api.resolveAssetUrl('uploads/a.png')).toBe('https://api.acme.com/uploads/a.png');
  });

  test('an absolute url is left alone', () => {
    const { api } = harness();

    expect(api.resolveAssetUrl('https://cdn.acme.com/a.png')).toBe('https://cdn.acme.com/a.png');
  });

  test('nothing in, nothing out', () => {
    const { api } = harness();

    expect(api.resolveAssetUrl('')).toBeUndefined();
    expect(api.resolveAssetUrl(null)).toBeUndefined();
  });
});

test('requires a base url and a session', () => {
  expect(() => createApiClient({ session: {} })).toThrow(/baseUrl/i);
  expect(() => createApiClient({ baseUrl: 'https://x' })).toThrow(/session/i);
});
