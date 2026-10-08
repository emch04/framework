const crypto = require('crypto');
const { createContextCipher } = require('../src');
const { normalizeScope, sameScope, rowId, contextBytes, versionMetadata } = require('../src/context');
const context = { tenant: 'org', environment: 'production', name: 'KEY', version: 1 };
const value = ['private', 'fixture'].join('-');
const make = () => createContextCipher({ key: crypto.randomBytes(32) });
test('AES-GCM authenticates plaintext and uses a fresh nonce', () => {
  const cipher = make();
  const a = cipher.encrypt(value, context);
  const b = cipher.encrypt(value, context);
  expect(a).not.toBe(b);
  expect(a).not.toContain(value);
  expect(cipher.decrypt(a, { version: 1, name: 'KEY', environment: 'production', tenant: 'org' })).toBe(value);
});
test.each(['tenant', 'environment', 'name', 'version'])('changing %s refuses the ciphertext', field => {
  const cipher = make();
  expect(() => cipher.decrypt(cipher.encrypt(value, context), { ...context, [field]: field === 'version' ? 2 : 'other' })).toThrow('refused');
});
test.each(['iv', 'tag', 'data', 'v'])('tampering with %s fails safely', field => {
  const cipher = make();
  const parsed = JSON.parse(cipher.encrypt(value, context));
  parsed[field] = field === 'v' ? 2 : Buffer.alloc(field === 'iv' ? 12 : 16).toString('base64');
  expect(() => cipher.decrypt(JSON.stringify(parsed), context)).toThrow('Credential decryption refused.');
});
test('wrong key, malformed payload and missing context cannot decrypt', () => {
  const cipher = make();
  const payload = cipher.encrypt(value, context);
  expect(() => make().decrypt(payload, context)).toThrow('refused');
  for (const malformed of [value, '{}', 'null', JSON.stringify({ v: 1, iv: '!' })]) {
    expect(() => cipher.decrypt(malformed, context)).toThrow('refused');
  }
  expect(() => cipher.decrypt(payload)).toThrow('refused');
  expect(() => cipher.encrypt(value)).toThrow('context');
});
test('key and context configuration is validated without exposing input', () => {
  expect(() => createContextCipher({ key: value })).toThrow('32-byte');
  expect(() => createContextCipher({ key: Buffer.alloc(16) })).toThrow('32-byte');
  for (const invalid of [{}, { ...context, version: -1 }, { ...context, tenant: null }]) {
    expect(() => contextBytes(invalid)).toThrow('context');
  }
});
test('scope identity is unambiguous and flat does not match a tenant', () => {
  expect(normalizeScope()).toBeNull();
  expect(() => normalizeScope({ tenant: 'org' })).toThrow('scope');
  expect(rowId('c', { tenant: 'a:b', environment: 'x' })).not.toBe(rowId('b:c', { tenant: 'a', environment: 'x' }));
  expect(sameScope({ tenant: 'org', environment: 'production' }, null)).toBe(false);
  expect(versionMetadata({ key: 'KEY', value, other: value })).not.toHaveProperty('value');
});
