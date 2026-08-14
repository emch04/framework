const { createCorsMiddleware } = require('../src');

const createRes = () => {
  const headers = {};
  const res = {};
  res.setHeader = jest.fn((name, value) => { headers[name.toLowerCase()] = value; });
  res.getHeader = jest.fn((name) => headers[name.toLowerCase()]);
  res.status = jest.fn(() => res);
  res.end = jest.fn(() => res);
  res.headers = headers;
  return res;
};

describe('cors', () => {
  test('sets Access-Control-Allow-Origin for an explicitly allowed origin', () => {
    const res = createRes();
    const next = jest.fn();

    createCorsMiddleware({ allowedOrigins: ['https://app.example.com'] })(
      { method: 'GET', headers: { origin: 'https://app.example.com' } },
      res,
      next
    );

    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('does not reflect an origin that is not allowed', () => {
    const res = createRes();
    const next = jest.fn();

    createCorsMiddleware({ allowedOrigins: ['https://app.example.com'] })(
      { method: 'GET', headers: { origin: 'https://evil.example.com' } },
      res,
      next
    );

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('allows 127.0.0.1/localhost origins outside production by default', () => {
    const res = createRes();
    const next = jest.fn();
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    createCorsMiddleware()(
      { method: 'GET', headers: { origin: 'http://127.0.0.1:5273' } },
      res,
      next
    );

    process.env.NODE_ENV = originalEnv;
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5273');
  });

  test('rejects dev origins in production even without an explicit allow-list', () => {
    const res = createRes();
    const next = jest.fn();
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    createCorsMiddleware()(
      { method: 'GET', headers: { origin: 'http://127.0.0.1:5273' } },
      res,
      next
    );

    process.env.NODE_ENV = originalEnv;
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('short-circuits OPTIONS preflight requests with 204', () => {
    const res = createRes();
    const next = jest.fn();

    createCorsMiddleware({ allowedOrigins: ['https://app.example.com'] })(
      { method: 'OPTIONS', headers: { origin: 'https://app.example.com' } },
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  test('omits Access-Control-Allow-Credentials when credentials: false', () => {
    const res = createRes();
    const next = jest.fn();

    createCorsMiddleware({ allowedOrigins: ['https://app.example.com'], credentials: false })(
      { method: 'GET', headers: { origin: 'https://app.example.com' } },
      res,
      next
    );

    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
