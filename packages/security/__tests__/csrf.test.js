const { createCsrfMiddleware, createCsrfCookiePrimer } = require('../src');

const createRes = () => {
  const headers = {};
  return {
    headers,
    status: jest.fn(() => ({
      json: jest.fn((payload) => {
        headers.body = payload;
      })
    })),
    setHeader: jest.fn((name, value) => {
      headers[name.toLowerCase()] = value;
    }),
    getHeader: jest.fn((name) => headers[name.toLowerCase()])
  };
};

describe('csrf', () => {
  test('returns 403 when a mutating request has no CSRF token', () => {
    const res = createRes();
    const next = jest.fn();

    createCsrfMiddleware()({ method: 'POST', cookies: {}, headers: {} }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(res.headers.body).toEqual({ success: false, message: 'Invalid CSRF token.' });
  });

  test('returns 403 when the header token differs from the cookie token', () => {
    const res = createRes();
    const next = jest.fn();

    createCsrfMiddleware()({
      method: 'DELETE',
      cookies: { astratra_csrf: 'cookie-token' },
      headers: { 'x-csrf-token': 'header-token' }
    }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows mutating requests when the header token matches the cookie token', () => {
    const res = createRes();
    const next = jest.fn();

    createCsrfMiddleware()({
      method: 'PATCH',
      cookies: { astratra_csrf: 'same-token' },
      headers: { 'x-csrf-token': 'same-token' }
    }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('allows GET requests and sets a readable CSRF cookie when absent', () => {
    const res = createRes();
    const next = jest.fn();

    createCsrfMiddleware()({ method: 'GET', cookies: {}, headers: {} }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers['set-cookie']).toMatch(/^astratra_csrf=[a-f0-9]{64}; Path=\/; Secure; SameSite=Lax$/);
    expect(res.headers['set-cookie']).not.toContain('HttpOnly');
  });

  test('skip allows excluded routes without requiring a token', () => {
    const res = createRes();
    const next = jest.fn();

    createCsrfMiddleware({ skip: (req) => req.path === '/webhook' })(
      { method: 'POST', path: '/webhook', cookies: {}, headers: {} },
      res,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('createCsrfCookiePrimer', () => {
  test('sets the CSRF cookie on a GET request when absent', () => {
    const res = createRes();
    const next = jest.fn();

    createCsrfCookiePrimer()({ method: 'GET', cookies: {}, headers: {} }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers['set-cookie']).toMatch(/^astratra_csrf=[a-f0-9]{64}; Path=\/; Secure; SameSite=Lax$/);
  });

  test('does not overwrite an existing CSRF cookie', () => {
    const res = createRes();
    const next = jest.fn();

    createCsrfCookiePrimer()({ method: 'HEAD', cookies: { astratra_csrf: 'existing-token' }, headers: {} }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  test('never validates or rejects a mutating request — that stays createCsrfMiddleware\'s job', () => {
    const res = createRes();
    const next = jest.fn();

    createCsrfCookiePrimer()({ method: 'POST', cookies: {}, headers: {} }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('respects skip', () => {
    const res = createRes();
    const next = jest.fn();

    createCsrfCookiePrimer({ skip: (req) => req.path === '/health' })(
      { method: 'GET', path: '/health', cookies: {}, headers: {} },
      res,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
