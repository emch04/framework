const { createFieldCipher, generateFieldEncryptionKey } = require('../src');

describe('field encryption', () => {
  test('generateFieldEncryptionKey produces a usable 32-byte base64 key', () => {
    const key = generateFieldEncryptionKey();
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
  });

  test('encrypt then decrypt round-trips the original value', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });

    const encrypted = cipher.encrypt('4242-4242-4242-4242');

    expect(encrypted).not.toContain('4242');
    expect(cipher.decrypt(encrypted)).toBe('4242-4242-4242-4242');
  });

  test('accepts a hex-encoded key', () => {
    const hexKey = require('crypto').randomBytes(32).toString('hex');
    const cipher = createFieldCipher({ key: hexKey });

    expect(cipher.decrypt(cipher.encrypt('secret'))).toBe('secret');
  });

  test('accepts a raw Buffer key', () => {
    const cipher = createFieldCipher({ key: require('crypto').randomBytes(32) });

    expect(cipher.decrypt(cipher.encrypt('secret'))).toBe('secret');
  });

  test('two encryptions of the same value produce different ciphertext (random IV)', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });

    expect(cipher.encrypt('same-value')).not.toBe(cipher.encrypt('same-value'));
  });

  test('decrypting with the wrong key throws instead of returning garbage', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const other = createFieldCipher({ key: generateFieldEncryptionKey() });

    expect(() => other.decrypt(cipher.encrypt('secret'))).toThrow();
  });

  test('a tampered ciphertext fails to decrypt (authenticated encryption)', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const encrypted = cipher.encrypt('secret');
    const [iv, authTag, ciphertext] = encrypted.split('.');
    const tampered = [iv, authTag, `${ciphertext.slice(0, -2)}zz`].join('.');

    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  test('rejects a key of the wrong length', () => {
    expect(() => createFieldCipher({ key: Buffer.from('too-short') })).toThrow(/32-byte/);
  });

  test('rejects encrypting null or undefined', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });

    expect(() => cipher.encrypt(null)).toThrow();
    expect(() => cipher.encrypt(undefined)).toThrow();
  });
});
