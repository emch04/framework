const { requestIdMiddleware } = require('../src');

function createResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    }
  };
}

describe('requestIdMiddleware', () => {
  test('reuses an incoming X-Request-Id header', () => {
    const req = { headers: { 'x-request-id': 'existing-id' } };
    const res = createResponse();
    const next = jest.fn();

    requestIdMiddleware(req, res, next);

    expect(req.requestId).toBe('existing-id');
    expect(res.headers['X-Request-Id']).toBe('existing-id');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('generates a UUID when no request id is provided', () => {
    const req = { headers: {} };
    const res = createResponse();
    const next = jest.fn();

    requestIdMiddleware(req, res, next);

    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(res.headers['X-Request-Id']).toBe(req.requestId);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
