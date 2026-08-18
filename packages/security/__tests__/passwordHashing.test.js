const { hashPassword, verifyPasswordHash, isStrongPassword } = require('../src');

describe('password hashing', () => {
  test('hash then verify round-trips correctly', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).not.toContain('correct horse');
    await expect(verifyPasswordHash('correct horse battery staple', hash)).resolves.toBe(true);
  });

  test('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPasswordHash('wrong password', hash)).resolves.toBe(false);
  });

  test('two hashes of the same password differ (random salt)', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');

    expect(first).not.toBe(second);
    await expect(verifyPasswordHash('same-password', first)).resolves.toBe(true);
    await expect(verifyPasswordHash('same-password', second)).resolves.toBe(true);
  });

  test('honors a custom (lower, test-speed) cost factor', async () => {
    const hash = await hashPassword('speedy', { cost: 1024 });

    expect(hash.split('$')[1]).toBe('1024');
    await expect(verifyPasswordHash('speedy', hash)).resolves.toBe(true);
  });

  test('rejects malformed or foreign hash strings instead of throwing', async () => {
    await expect(verifyPasswordHash('anything', 'not-a-real-hash')).resolves.toBe(false);
    await expect(verifyPasswordHash('anything', '$2b$10$abcdefghijklmnopqrstuv')).resolves.toBe(false); // bcrypt-shaped
    await expect(verifyPasswordHash('anything', '')).resolves.toBe(false);
    await expect(verifyPasswordHash('anything', null)).resolves.toBe(false);
  });

  test('rejects a hash string with an absurd cost factor rather than allocating for it', async () => {
    const forged = ['scrypt', '999999999', '8', '1', 'AAAA', 'AAAA'].join('$');

    await expect(verifyPasswordHash('anything', forged)).resolves.toBe(false);
  });

  test('hashPassword rejects an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow(/non-empty/);
  });
});

describe('isStrongPassword', () => {
  test('accepts a password with all 4 categories and default min length', () => {
    expect(isStrongPassword('Correct1!')).toBe(true);
  });

  test('rejects missing uppercase', () => {
    expect(isStrongPassword('correct1!')).toBe(false);
  });

  test('rejects missing lowercase', () => {
    expect(isStrongPassword('CORRECT1!')).toBe(false);
  });

  test('rejects missing digit', () => {
    expect(isStrongPassword('Correctly!')).toBe(false);
  });

  test('rejects missing special character', () => {
    expect(isStrongPassword('Correct123')).toBe(false);
  });

  test('rejects below the minimum length even with all categories', () => {
    expect(isStrongPassword('C1!')).toBe(false);
  });

  test('rejects non-string input instead of throwing', () => {
    expect(isStrongPassword(undefined)).toBe(false);
    expect(isStrongPassword(null)).toBe(false);
    expect(isStrongPassword(12345678)).toBe(false);
  });

  test('honors individually disabled categories', () => {
    expect(isStrongPassword('correctlylongenough', {
      requireUppercase: false, requireDigit: false, requireSpecial: false
    })).toBe(true);
  });

  test('honors a custom minLength', () => {
    expect(isStrongPassword('Ab1!Ab1!', { minLength: 12 })).toBe(false);
    expect(isStrongPassword('Ab1!Ab1!Ab1!', { minLength: 12 })).toBe(true);
  });
});
