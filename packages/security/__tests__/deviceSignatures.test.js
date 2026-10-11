const crypto = require('crypto');
const {
  createDeviceSignatureVerifier,
  createMemoryDeviceStore,
  canonicalDeviceRequest,
  DeviceSignatureError
} = require('../src');

/* A phone as the chip behaves: P-256 keys, DER signatures, the raw 65-byte public point exported. */
function phone(id = 'iphone-emch-0001') {
  const device = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const biometric = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const raw = (pair) => pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65).toString('base64');
  let n = 0;
  function sign(pair, { method, path, body = '', time = Date.now(), nonce }) {
    const data = canonicalDeviceRequest({ method, path, time, nonce, body });
    return crypto.sign('sha256', Buffer.from(data), { key: pair.privateKey, dsaEncoding: 'der' }).toString('base64');
  }
  return {
    id,
    publicKey: raw(device),
    biometricPublicKey: raw(biometric),
    request({ method = 'GET', path = '/conversation', body = '', time = Date.now(), nonce, key = 'device' } = {}) {
      const usedNonce = nonce || `nonce-${id}-${(n += 1)}-${crypto.randomBytes(6).toString('hex')}`;
      const pair = key === 'biometric' ? biometric : device;
      return {
        method, path, body,
        headers: {
          'x-device-id': id, 'x-device-time': String(time), 'x-device-nonce': usedNonce,
          'x-device-signature': sign(pair, { method, path, body, time, nonce: usedNonce }), 'x-device-key': key
        },
        biometricSignature: sign(biometric, { method, path, body, time, nonce: usedNonce })
      };
    }
  };
}

async function enrolled(options = {}) {
  const store = createMemoryDeviceStore();
  const verifier = createDeviceSignatureVerifier({ store, ...options });
  const me = phone();
  const req = me.request({ method: 'POST', path: '/appareil', body: '{}' });
  await verifier.enroll(req, { id: me.id, publicKey: me.publicKey, biometricPublicKey: me.biometricPublicKey, biometricSignature: req.biometricSignature });
  return { store, verifier, me };
}

const code = (promise) => promise.then(() => 'ok', (e) => (e instanceof DeviceSignatureError ? e.code : `other: ${e.message}`));

describe('device signatures', () => {
  test('an enrolled phone is recognised on every request, without any sign-in', async () => {
    const { verifier, me } = await enrolled();
    const r = await verifier.verify(me.request());
    expect(r).toEqual({ device: { id: me.id, label: null }, biometric: false });
  });

  test('the one-device pattern: the first phone enrols, the door then closes for good', async () => {
    const { verifier } = await enrolled({ maxDevices: 1 });
    expect(await verifier.enrollmentOpen()).toBe(false);
    const other = phone('iphone-intrus-0002');
    const req = other.request({ method: 'POST', path: '/appareil', body: '{}' });
    expect(await code(verifier.enroll(req, { id: other.id, publicKey: other.publicKey }))).toBe('closed');
    expect(await code(verifier.verify(other.request()))).toBe('unknown_device');
  });

  test('enrolment proves possession: keys the caller cannot sign with are refused', async () => {
    const store = createMemoryDeviceStore();
    const verifier = createDeviceSignatureVerifier({ store, maxDevices: 1 });
    const thief = phone('iphone-voleur-003');
    const victim = phone('iphone-victime-04');
    const req = thief.request({ method: 'POST', path: '/appareil', body: '{}' });
    expect(await code(verifier.enroll(req, { id: thief.id, publicKey: victim.publicKey }))).toBe('bad_signature');
    expect(await verifier.enrollmentOpen()).toBe(true);
  });

  test('a replayed request is refused, even a second later', async () => {
    const { verifier, me } = await enrolled();
    const req = me.request({ nonce: 'nonce-unique-123456' });
    await verifier.verify(req);
    expect(await code(verifier.verify(req))).toBe('replay');
  });

  test('a stale or future signature is refused', async () => {
    const { verifier, me } = await enrolled();
    expect(await code(verifier.verify(me.request({ time: Date.now() - 5 * 60_000 })))).toBe('stale');
    expect(await code(verifier.verify(me.request({ time: Date.now() + 5 * 60_000 })))).toBe('stale');
  });

  test('a changed method, path or body byte breaks the signature', async () => {
    const { verifier, me } = await enrolled();
    const req = me.request({ method: 'POST', path: '/arret', body: '{"duree":60}' });
    expect(await code(verifier.verify({ ...req, body: '{"duree":61}' }))).toBe('bad_signature');
    expect(await code(verifier.verify({ ...req, path: '/autre' }))).toBe('bad_signature');
    expect(await code(verifier.verify({ ...req, method: 'DELETE' }))).toBe('bad_signature');
  });

  test('a forged signature does not burn the real phone\'s nonce', async () => {
    const { verifier, me } = await enrolled();
    const real = me.request({ nonce: 'nonce-partage-7890ab' });
    const forged = { ...real, headers: { ...real.headers, 'x-device-signature': Buffer.alloc(70, 1).toString('base64') } };
    expect(await code(verifier.verify(forged))).toBe('bad_signature');
    expect(await code(verifier.verify(real))).toBe('ok');
  });

  test('an action that requires Face ID accepts only the biometric key', async () => {
    const { verifier, me } = await enrolled();
    expect(await code(verifier.verify(me.request({ method: 'POST', path: '/arret' }), { requireBiometric: true }))).toBe('biometric_required');
    const r = await verifier.verify(me.request({ method: 'POST', path: '/arret', key: 'biometric' }), { requireBiometric: true });
    expect(r.biometric).toBe(true);
  });

  test('a revoked phone is refused', async () => {
    const { verifier, me } = await enrolled();
    await verifier.revoke(me.id);
    expect(await code(verifier.verify(me.request()))).toBe('revoked');
  });

  test('keys that are not P-256 are refused at enrolment', async () => {
    const store = createMemoryDeviceStore();
    const verifier = createDeviceSignatureVerifier({ store });
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    const me = phone();
    expect(await code(verifier.enroll(me.request({ method: 'POST', path: '/appareil' }), { id: me.id, publicKey: rsa }))).toBe('bad_key');
  });

  test('the middleware answers every refusal the same way (404 to look absent), and lets the phone in', async () => {
    const { verifier, me } = await enrolled();
    const guard = verifier.middleware({ rejectStatus: 404 });
    async function call(req) {
      const out = { status: 200, body: null, passed: false, device: null };
      const res = { status(c) { out.status = c; return this; }, json(b) { out.body = JSON.stringify(b); return this; } };
      const request = { method: req.method, originalUrl: req.path, headers: req.headers, body: Buffer.from(req.body || '') };
      await guard(request, res, () => { out.passed = true; out.device = request.device.id; });
      return out;
    }
    const good = await call(me.request());
    const stranger = await call(phone('iphone-inconnu-05').request());
    const replay = me.request();
    await call(replay);
    const again = await call(replay);
    expect(good).toMatchObject({ passed: true, device: me.id });
    expect(stranger).toMatchObject({ passed: false, status: 404 });
    expect(again).toMatchObject({ passed: false, status: 404 });
    expect(stranger.body).toBe(again.body);
  });
});
