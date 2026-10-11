const http2 = require('http2');
const { generateKeyPairSync, verify } = require('crypto');
const { createApnsTransport, createPushSender, apnsBody } = require('../src');

const TOKEN = 'ab'.repeat(32);
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/* A fake Apple gateway over cleartext HTTP/2: what the transport really puts on the wire. */
async function fakeApple(answer = () => ({ status: 200 })) {
  const requests = [];
  const sessions = new Set();
  const server = http2.createServer();
  server.on('session', (s) => sessions.add(s));
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => { body += c; });
    stream.on('end', () => {
      requests.push({ headers, body: JSON.parse(body) });
      const { status, reason } = answer(headers);
      stream.respond({ ':status': status });
      stream.end(reason ? JSON.stringify({ reason }) : '');
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    sessions,
    close: () => new Promise((ok) => { for (const s of sessions) s.destroy(); server.close(ok); })
  };
}

function jwtValid(authorization) {
  const [head, claims, signature] = authorization.replace(/^bearer /, '').split('.');
  return verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
    ? { head: JSON.parse(Buffer.from(head, 'base64url')), claims: JSON.parse(Buffer.from(claims, 'base64url')) }
    : null;
}

describe('createApnsTransport', () => {
  let apple;
  afterEach(async () => { await apple?.close(); apple = null; });

  test('sends an alert to the device path with a provider token signed by the .p8 key', async () => {
    apple = await fakeApple();
    const transport = createApnsTransport({ key: KEY, keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'com.example.app', url: apple.url });
    await transport(TOKEN, { title: 'Hé', body: 'Une alerte', data: { alerteId: 'a1' }, badge: 3, urgent: true });
    transport.close();

    const [r] = apple.requests;
    expect(r.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(r.headers['apns-topic']).toBe('com.example.app');
    expect(r.headers['apns-push-type']).toBe('alert');
    const jwt = jwtValid(r.headers.authorization);
    expect(jwt).not.toBeNull();
    expect(jwt.head).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(jwt.claims.iss).toBe('TEAM123456');
    expect(r.body).toEqual({ alerteId: 'a1', aps: { alert: { title: 'Hé', body: 'Une alerte' }, sound: 'default', badge: 3, 'interruption-level': 'time-sensitive' } });
  });

  test('the provider token is reused for 50 minutes, then signed again', async () => {
    apple = await fakeApple();
    let clock = 1_000_000;
    const transport = createApnsTransport({ key: KEY, keyId: 'K', teamId: 'T', topic: 'x', url: apple.url, now: () => clock });
    await transport(TOKEN, { title: 'a' });
    clock += 49 * 60_000;
    await transport(TOKEN, { title: 'b' });
    clock += 2 * 60_000;
    await transport(TOKEN, { title: 'c' });
    transport.close();
    const tokens = apple.requests.map((r) => r.headers.authorization);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[1]);
  });

  test('one HTTP/2 connection carries every send', async () => {
    apple = await fakeApple();
    const transport = createApnsTransport({ key: KEY, keyId: 'K', teamId: 'T', topic: 'x', url: apple.url });
    await Promise.all([transport(TOKEN, { title: '1' }), transport(TOKEN, { title: '2' }), transport(TOKEN, { title: '3' })]);
    transport.close();
    expect(apple.requests).toHaveLength(3);
    expect(apple.sessions.size).toBe(1);
  });

  test('a dead device is handed back by createPushSender for pruning (410 and BadDeviceToken)', async () => {
    apple = await fakeApple((h) => (h[':path'].includes('dead') || h[':path'].endsWith('cd'.repeat(32)) ? { status: 400, reason: 'BadDeviceToken' } : { status: 410, reason: 'Unregistered' }));
    const transport = createApnsTransport({ key: KEY, keyId: 'K', teamId: 'T', topic: 'x', url: apple.url });
    const pruned = [];
    const push = createPushSender({ transport, onGone: async (s) => { pruned.push(s); } });
    const report = await push.broadcast([TOKEN, 'cd'.repeat(32)], { title: 'x' });
    transport.close();
    expect(report).toMatchObject({ gone: 2, delivered: 0, failed: 0 });
    expect(pruned).toEqual([TOKEN, 'cd'.repeat(32)]);
  });

  test('any other refusal is a failure with its status and reason, never a pruning', async () => {
    apple = await fakeApple(() => ({ status: 429, reason: 'TooManyRequests' }));
    const transport = createApnsTransport({ key: KEY, keyId: 'K', teamId: 'T', topic: 'x', url: apple.url });
    await expect(transport(TOKEN, { title: 'x' })).rejects.toMatchObject({ statusCode: 429, reason: 'TooManyRequests' });
    transport.close();
  });

  test('a malformed device token never reaches Apple', async () => {
    apple = await fakeApple();
    const transport = createApnsTransport({ key: KEY, keyId: 'K', teamId: 'T', topic: 'x', url: apple.url });
    await expect(transport('pas-un-jeton', { title: 'x' })).rejects.toMatchObject({ statusCode: 410 });
    expect(apple.requests).toHaveLength(0);
  });

  test('a key stored on one line (vault, .env) is accepted; a missing setting fails at creation', () => {
    const oneLine = KEY.replace(/\n/g, ' ');
    expect(() => createApnsTransport({ key: oneLine, keyId: 'K', teamId: 'T', topic: 'x' })).not.toThrow();
    expect(() => createApnsTransport({ key: KEY, keyId: 'K', teamId: 'T' })).toThrow(/topic/);
    expect(() => createApnsTransport({ keyId: 'K', teamId: 'T', topic: 'x' })).toThrow(/key/);
  });

  test('apnsBody: a background push carries no alert and no sound', () => {
    expect(JSON.parse(apnsBody({ contentAvailable: true, sound: null, data: { k: 'v' } }))).toEqual({ k: 'v', aps: { 'content-available': 1 } });
  });
});
