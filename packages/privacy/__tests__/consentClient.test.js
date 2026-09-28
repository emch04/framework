const { createConsentClient } = require('../src');

/**
 * The guard, run for real: an in-memory "server" and "device storage", and we
 * count what actually leaves towards the AI.
 */
function build({ routeExists = true, version = 2, current = 'account-1' } = {}) {
  const server = { routeExists, decision: null, calls: [] };
  const storage = new Map();
  const errors = [];
  let clock = Date.parse('2026-09-28T10:00:00.000Z');
  let subject = current;
  const client = createConsentClient({
    version,
    scope: 'ai',
    local: { get: async (key) => (storage.has(key) ? storage.get(key) : null), set: async (key, value) => { storage.set(key, value); } },
    remote: {
      get: async () => {
        server.calls.push('GET');
        if (!server.routeExists) throw Object.assign(new Error('Not found'), { status: 404 });
        return server.decision;
      },
      put: async (body) => {
        server.calls.push('PUT');
        if (!server.routeExists) throw Object.assign(new Error('Not found'), { status: 404 });
        server.decision = { ...body, decidedAt: new Date(clock).toISOString() };
        return server.decision;
      }
    },
    currentSubject: () => subject,
    now: () => new Date(clock),
    onError: (where) => errors.push(where)
  });

  let leftForAi = 0;
  const sendToAi = async () => { await client.require(); leftForAi += 1; };
  return {
    client, server, storage, errors,
    sendToAi, sent: () => leftForAi,
    advance: (ms) => { clock += ms; },
    switchTo: (id) => { subject = id; }
  };
}

test('without a decision the guard blocks every send, and nothing leaves', async () => {
  const { sendToAi, sent } = build();
  await expect(sendToAi()).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  expect(sent()).toBe(0);
});

test('refusing: nothing leaves, and the refusal is kept on the account', async () => {
  const { client, sendToAi, sent, server } = build();
  await client.decide('account-1', false);
  await expect(sendToAi()).rejects.toMatchObject({ code: 'CONSENT_REFUSED' });
  expect(sent()).toBe(0);
  expect(server.decision).toMatchObject({ granted: false, version: 2 });
});

test('accepting opens the sends; withdrawing closes them at once', async () => {
  const { client, sendToAi, sent } = build();
  await client.decide('account-1', true);
  await sendToAi();
  expect(sent()).toBe(1);
  await client.decide('account-1', false);
  await expect(sendToAi()).rejects.toMatchObject({ code: 'CONSENT_REFUSED' });
  expect(sent()).toBe(1);
});

test('a withdrawal made on ANOTHER device blocks this one, despite its old yes', async () => {
  const { client, storage, server, sendToAi, sent } = build();
  storage.set('consent.ai.account-1', JSON.stringify({ granted: true, version: 2, decidedAt: '2026-09-20T10:00:00.000Z' }));
  server.decision = { granted: false, version: 2, decidedAt: '2026-09-21T10:00:00.000Z' };
  await expect(sendToAi()).rejects.toMatchObject({ code: 'CONSENT_REFUSED' });
  expect(sent()).toBe(0);
  expect(JSON.parse(storage.get('consent.ai.account-1')).granted).toBe(false);
  expect(client.stateOf()).toBe('refused');
});

test('a yes given on another device is enough here', async () => {
  const { server, sendToAi, sent } = build();
  server.decision = { granted: true, version: 2, decidedAt: '2026-09-21T10:00:00.000Z' };
  await sendToAi();
  expect(sent()).toBe(1);
});

test('a yes on the older text is asked again after the version is raised', async () => {
  const { server, sendToAi } = build({ version: 2 });
  server.decision = { granted: true, version: 1, decidedAt: '2026-09-21T10:00:00.000Z' };
  await expect(sendToAi()).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
});

test('a server too old for the route: the local yes holds, and a local no too', async () => {
  const { client, sendToAi, sent, errors } = build({ routeExists: false });
  await client.decide('account-1', true);
  await sendToAi();
  expect(sent()).toBe(1);
  await client.decide('account-1', false);
  await expect(sendToAi()).rejects.toMatchObject({ code: 'CONSENT_REFUSED' });
  expect(errors).toContain('push');
});

test('one account never benefits from another account\'s yes on the same device', async () => {
  const { client, sendToAi, switchTo, server } = build({ current: 'account-1' });
  await client.decide('other-account', true);
  /* The fake server has one slot; the real route answers for the signed-in account. */
  server.decision = null;
  switchTo('account-1');
  await expect(sendToAi()).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
});

test('a withdrawal made here offline is pushed on the next load, not erased by the server\'s old yes', async () => {
  const { client, server, storage, advance } = build();
  server.decision = { granted: true, version: 2, decidedAt: '2026-09-27T10:00:00.000Z' };
  storage.set('consent.ai.account-1', JSON.stringify({ granted: false, version: 2, decidedAt: '2026-09-28T09:00:00.000Z' }));
  advance(1000);
  expect(await client.load('account-1')).toMatchObject({ granted: false });
  await new Promise((resolve) => setImmediate(resolve));
  expect(server.decision.granted).toBe(false);
});

test('a load that started BEFORE a decision never overwrites it on its way back', async () => {
  const server = { decision: { granted: true, version: 2, decidedAt: '2026-09-27T10:00:00.000Z' } };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = createConsentClient({
    version: 2,
    local: { get: async () => null, set: async () => {} },
    remote: { get: async () => { await gate; return server.decision; }, put: async () => {} },
    now: () => new Date('2026-09-28T10:00:00.000Z')
  });
  const loading = client.load('account-1');
  await client.decide('account-1', false);
  release();
  await loading;
  expect(client.state().decision.granted).toBe(false);
});

test('a loaded account costs no request; two loads share one', async () => {
  const { client, server } = build();
  await Promise.all([client.load('account-1'), client.load('account-1')]);
  await client.load('account-1');
  expect(server.calls.filter((call) => call === 'GET')).toHaveLength(1);
  await client.load('account-1', { refresh: true });
  expect(server.calls.filter((call) => call === 'GET')).toHaveLength(2);
});

test('subscribers hear every change; isGranted stays silent instead of throwing', async () => {
  const { client } = build();
  const heard = [];
  const stop = client.subscribe((state) => heard.push(state.decision && state.decision.granted));
  expect(await client.isGranted()).toBe(false);
  await client.decide('account-1', true);
  expect(await client.isGranted()).toBe(true);
  stop();
  await client.decide('account-1', false);
  expect(heard).toContain(true);
  expect(heard[heard.length - 1]).toBe(true);
});

test('a corrupted local copy is ignored, never read as a yes', async () => {
  const { client, storage } = build({ routeExists: false });
  storage.set('consent.ai.account-1', '{not json');
  expect(await client.load('account-1')).toBeNull();
  expect(await client.isGranted()).toBe(false);
});

test('wiring mistakes are refused up front', () => {
  const local = { get: async () => null, set: async () => {} };
  const remote = { get: async () => null, put: async () => {} };
  expect(() => createConsentClient({ local, remote })).toThrow(/version/);
  expect(() => createConsentClient({ version: 1, remote })).toThrow(/local/);
  expect(() => createConsentClient({ version: 1, local })).toThrow(/remote/);
});
