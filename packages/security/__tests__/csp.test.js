const { createCspMiddleware, DEFAULT_CSP_DIRECTIVES } = require('../src');

const createRes = () => {
  const headers = {};
  return {
    headers,
    setHeader: jest.fn((name, value) => {
      headers[name] = value;
    })
  };
};

describe('csp', () => {
  test('sets a restrictive default-src none policy by default', () => {
    const res = createRes();
    const next = jest.fn();

    createCspMiddleware()({}, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining("default-src 'none'"));
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('exposes the default directives for consumers who want to extend them', () => {
    expect(DEFAULT_CSP_DIRECTIVES['default-src']).toEqual(["'none'"]);
  });

  test('merges custom directives on top of the defaults', () => {
    const res = createRes();

    createCspMiddleware({
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'img-src': ["'self'", 'data:']
      }
    })({}, res, jest.fn());

    const header = res.headers['Content-Security-Policy'];
    expect(header).toContain("default-src 'self'");
    expect(header).toContain("script-src 'self'");
    expect(header).toContain("img-src 'self' data:");
    expect(header).toContain("frame-ancestors 'none'");
  });

  test('uses the report-only header when reportOnly is set', () => {
    const res = createRes();

    createCspMiddleware({ reportOnly: true })({}, res, jest.fn());

    expect(res.setHeader).toHaveBeenCalledWith('Content-Security-Policy-Report-Only', expect.any(String));
    expect(res.headers['Content-Security-Policy']).toBeUndefined();
  });
});
