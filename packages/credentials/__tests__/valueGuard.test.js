const { createValueGuard, createPermissiveGuard } = require('../src');

const stripeish = () => createValueGuard({
  keys: ['SECRET_KEY', 'WEBHOOK_SECRET'],
  decidingKey: 'SECRET_KEY',
  livePattern: /^sk_live_/,
  testPattern: /^sk_test_/,
  isProduction: () => false
});

describe('value guard', () => {
  test('guards nothing by default', () => {
    const guard = createPermissiveGuard();

    expect(guard.isGuarded('SECRET_KEY')).toBe(false);
    expect(guard.mayWrite('SECRET_KEY', 'sk_live_anything')).toEqual({ ok: true });
    expect(guard.mayRead('SECRET_KEY', { value: 'sk_live_anything' })).toBe(true);
  });

  test('a live value cannot be written outside production', () => {
    const result = stripeish().mayWrite('SECRET_KEY', 'sk_live_abc');

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/production/i);
  });

  test('a test value is writable anywhere', () => {
    expect(stripeish().mayWrite('SECRET_KEY', 'sk_test_abc')).toEqual({ ok: true });
  });

  test('in production, a live value is writable', () => {
    const guard = createValueGuard({
      keys: ['SECRET_KEY'],
      livePattern: /^sk_live_/,
      isProduction: () => true
    });

    expect(guard.mayWrite('SECRET_KEY', 'sk_live_abc')).toEqual({ ok: true });
  });

  test('an unguarded key is never restricted', () => {
    expect(stripeish().mayWrite('MAIL_API_KEY', 'sk_live_abc')).toEqual({ ok: true });
  });

  test('a live value cannot be read outside production', () => {
    expect(stripeish().mayRead('SECRET_KEY', { value: 'sk_live_abc' })).toBe(false);
  });

  test('a key that cannot classify itself follows the deciding key', () => {
    const guard = stripeish();

    // A webhook signing secret says nothing about which account it belongs to.
    expect(guard.mayRead('WEBHOOK_SECRET', { value: 'whsec_x', decidingValue: 'sk_live_abc' })).toBe(false);
    expect(guard.mayRead('WEBHOOK_SECRET', { value: 'whsec_x', decidingValue: 'sk_test_abc' })).toBe(true);
  });

  test('an unclassifiable value is not treated as live', () => {
    const guard = stripeish();

    expect(guard.classify('something-else')).toBe('unknown');
    expect(guard.mayRead('SECRET_KEY', { value: 'something-else' })).toBe(true);
  });

  test('restrictsHere answers before a value has been typed', () => {
    expect(stripeish().restrictsHere('SECRET_KEY').ok).toBe(false);
    expect(stripeish().restrictsHere('MAIL_API_KEY').ok).toBe(true);
  });

  test('a custom classify function replaces the patterns', () => {
    const guard = createValueGuard({
      keys: ['K'],
      classify: (value) => (String(value).endsWith('!') ? 'live' : 'test'),
      isProduction: () => false
    });

    expect(guard.mayWrite('K', 'real!').ok).toBe(false);
    expect(guard.mayWrite('K', 'fake').ok).toBe(true);
  });
});
