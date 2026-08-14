const { createSecurityHeadersMiddleware } = require('../src');

const createRes = () => {
  const headers = {};
  return {
    headers,
    setHeader: jest.fn((name, value) => { headers[name.toLowerCase()] = value; }),
    getHeader: jest.fn((name) => headers[name.toLowerCase()])
  };
};

describe('security headers', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  test('sets the standard hardening headers with sane defaults', () => {
    const res = createRes();
    const next = jest.fn();

    createSecurityHeadersMiddleware()({}, res, next);

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toContain('geolocation=()');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('does not set HSTS outside production by default', () => {
    process.env.NODE_ENV = 'development';
    const res = createRes();

    createSecurityHeadersMiddleware()({}, res, jest.fn());

    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  test('sets HSTS in production by default', () => {
    process.env.NODE_ENV = 'production';
    const res = createRes();

    createSecurityHeadersMiddleware()({}, res, jest.fn());

    expect(res.headers['strict-transport-security']).toMatch(/^max-age=\d+; includeSubDomains$/);
  });

  test('hsts can be forced on outside production with custom options', () => {
    process.env.NODE_ENV = 'development';
    const res = createRes();

    createSecurityHeadersMiddleware({ hsts: { maxAge: 3600, includeSubDomains: false } })({}, res, jest.fn());

    expect(res.headers['strict-transport-security']).toBe('max-age=3600');
  });

  test('individual headers can be disabled', () => {
    const res = createRes();

    createSecurityHeadersMiddleware({
      frameOptions: false,
      contentTypeOptions: false,
      referrerPolicy: false,
      permissionsPolicy: false
    })({}, res, jest.fn());

    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBeUndefined();
    expect(res.headers['permissions-policy']).toBeUndefined();
  });

  test('frameOptions and referrerPolicy accept custom values', () => {
    const res = createRes();

    createSecurityHeadersMiddleware({ frameOptions: 'SAMEORIGIN', referrerPolicy: 'no-referrer' })({}, res, jest.fn());

    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});
