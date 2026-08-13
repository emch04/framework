const { setSessionCookie, clearSessionCookie } = require('../src');

const createRes = () => {
  const headers = {};
  return {
    headers,
    setHeader: jest.fn((name, value) => {
      headers[name.toLowerCase()] = value;
    }),
    getHeader: jest.fn((name) => headers[name.toLowerCase()])
  };
};

describe('cookies', () => {
  test('sets an HttpOnly secure session cookie with configured attributes', () => {
    const res = createRes();

    setSessionCookie(res, 'jwt-token', {
      name: 'app_session',
      sameSite: 'strict',
      path: '/app',
      domain: 'example.test',
      maxAgeMs: 90 * 1000
    });

    expect(res.headers['set-cookie']).toBe(
      'app_session=jwt-token; Max-Age=90; Domain=example.test; Path=/app; HttpOnly; Secure; SameSite=Strict'
    );
  });

  test('omits Secure by default in development mode', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const res = createRes();

    try {
      setSessionCookie(res, 'jwt-token');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    expect(res.headers['set-cookie']).toBe('astratra_session=jwt-token; Path=/; HttpOnly; SameSite=Lax');
  });

  test('clears the configured session cookie with a past expiration', () => {
    const res = createRes();

    clearSessionCookie(res, {
      name: 'app_session',
      path: '/app',
      domain: 'example.test',
      secure: false,
      sameSite: 'none'
    });

    expect(res.headers['set-cookie']).toBe(
      'app_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=example.test; Path=/app; HttpOnly; SameSite=None'
    );
  });
});
