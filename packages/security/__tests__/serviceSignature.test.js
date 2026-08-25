const { createServiceSigner } = require('../src');

const build = (overrides = {}) => createServiceSigner({ secret: 'shared-internal-secret', ...overrides });

describe('service signature', () => {
  test('a signed value comes back intact', () => {
    const signer = build();
    const { payload, signature } = signer.sign({ id: 'u1', role: 'admin', school: 's9' });

    expect(signer.verify(payload, signature)).toMatchObject({
      valid: true, value: { id: 'u1', role: 'admin', school: 's9' }
    });
  });

  test('an altered payload is refused', () => {
    const signer = build();
    const { payload, signature } = signer.sign({ role: 'member' });

    expect(signer.verify(payload.replace('member', 'admin'), signature))
      .toEqual({ valid: false, reason: 'bad-signature' });
  });

  test('another secret cannot forge a signature', () => {
    const { payload } = build().sign({ role: 'admin' });
    const attacker = createServiceSigner({ secret: 'guessed' });
    const forged = attacker.sign({ role: 'admin' }).signature;

    expect(build().verify(payload, forged)).toEqual({ valid: false, reason: 'bad-signature' });
  });

  test('key order does not change the signature — two services build objects differently', () => {
    /* Service A builds { id, role }; service B rebuilds { role, id } from a
       database row. Plain JSON.stringify would disagree, intermittently, in a
       way that looks like a network fault. */
    const signer = build({ now: () => 1_000_000 });

    expect(signer.sign({ id: 'u1', role: 'admin' }).signature)
      .toBe(signer.sign({ role: 'admin', id: 'u1' }).signature);
  });

  test('a captured signature stops working once it expires', () => {
    /* Without a maximum age, one observed internal call can be replayed
       forever. */
    const signed = build({ maxAgeMs: 30_000, now: () => 1_000_000 }).sign({ role: 'admin' });
    const later = build({ maxAgeMs: 30_000, now: () => 1_000_000 + 31_000 });

    expect(later.verify(signed.payload, signed.signature)).toEqual({ valid: false, reason: 'expired' });
  });

  test('within its window it is accepted', () => {
    const signed = build({ maxAgeMs: 30_000, now: () => 1_000_000 }).sign({ role: 'admin' });
    const soon = build({ maxAgeMs: 30_000, now: () => 1_000_000 + 29_000 });

    expect(soon.verify(signed.payload, signed.signature).valid).toBe(true);
  });

  test('a timestamp from the future is refused, not trusted', () => {
    const signed = build({ maxAgeMs: 30_000, now: () => 2_000_000 }).sign({ role: 'admin' });
    const earlier = build({ maxAgeMs: 30_000, now: () => 1_000_000 });

    expect(earlier.verify(signed.payload, signed.signature)).toEqual({ valid: false, reason: 'expired' });
  });

  test('without a maximum age nothing expires — and that is a decision, not a default', () => {
    const signed = build({ now: () => 1_000_000 }).sign({ role: 'admin' });
    const muchLater = build({ now: () => 9_000_000_000 });

    expect(muchLater.verify(signed.payload, signed.signature).valid).toBe(true);
  });

  test('the signature is checked BEFORE the payload is parsed', () => {
    /* Parsing first would run the JSON parser on whatever an attacker sent. */
    const signer = build();

    expect(signer.verify('{ not json at all', 'deadbeef')).toEqual({ valid: false, reason: 'bad-signature' });
  });

  test('a validly signed but malformed payload is reported as such', () => {
    const signer = build();
    const crypto = require('crypto');
    const payload = 'not json';
    const signature = crypto.createHmac('sha256', 'shared-internal-secret').update(payload).digest('hex');

    expect(signer.verify(payload, signature)).toEqual({ valid: false, reason: 'malformed' });
  });

  test('a missing payload or signature is refused', () => {
    const signer = build();

    expect(signer.verify(null, 'x')).toEqual({ valid: false, reason: 'missing' });
    expect(signer.verify('x', null)).toEqual({ valid: false, reason: 'missing' });
  });

  test('signing works for primitives, not just objects', () => {
    const signer = build();

    for (const value of ['a-string', 42, true, null, ['a', 'b']]) {
      const { payload, signature } = signer.sign(value);
      expect(signer.verify(payload, signature).value).toEqual(value);
    }
  });

  test('headers carry the payload and the signature across HTTP', () => {
    const signer = build();
    const sent = signer.headers({ id: 'u1', role: 'admin' });

    expect(Object.keys(sent)).toEqual(['x-service-payload', 'x-service-signature']);
    expect(signer.verifyHeaders(sent)).toMatchObject({ valid: true, value: { id: 'u1', role: 'admin' } });
  });

  test('header names can be chosen', () => {
    const signer = build();
    const names = { payload: 'x-acme-body', signature: 'x-acme-sig' };

    expect(signer.verifyHeaders(signer.headers({ a: 1 }, names), names).valid).toBe(true);
  });

  test('missing or corrupt headers are refused, never thrown on', () => {
    const signer = build();

    expect(signer.verifyHeaders({})).toEqual({ valid: false, reason: 'missing' });
    expect(signer.verifyHeaders({ 'x-service-payload': '!!!', 'x-service-signature': 'abc' }).valid).toBe(false);
  });

  test('a signer with no secret is refused up front', () => {
    expect(() => createServiceSigner({})).toThrow(/secret/);
    expect(() => createServiceSigner({ secret: '' })).toThrow(/secret/);
  });
});
