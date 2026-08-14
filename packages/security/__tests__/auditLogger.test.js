const { EventEmitter } = require('events');
const { createSecurityAuditLogger } = require('../src');

const createRes = (statusCode) => {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
};

describe('security audit logger', () => {
  test('logs a structured event when the response status matches (401)', () => {
    const log = jest.fn();
    const res = createRes(401);
    const req = { method: 'POST', path: '/auth/login', headers: {}, requestId: 'req-1', connection: { remoteAddress: '10.0.0.1' } };

    createSecurityAuditLogger({ log })(req, res, jest.fn());
    res.emit('finish');

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('security_event', expect.objectContaining({
      status: 401,
      method: 'POST',
      path: '/auth/login',
      ip: '10.0.0.1',
      requestId: 'req-1'
    }));
  });

  test('falls back to req.id when req.requestId is absent', () => {
    const log = jest.fn();
    const res = createRes(401);
    const req = { method: 'GET', headers: {}, id: 'fallback-id' };

    createSecurityAuditLogger({ log })(req, res, jest.fn());
    res.emit('finish');

    expect(log).toHaveBeenCalledWith('security_event', expect.objectContaining({ requestId: 'fallback-id' }));
  });

  test('logs for 403 and 429 by default too', () => {
    const log = jest.fn();

    for (const status of [403, 429]) {
      const res = createRes(status);
      createSecurityAuditLogger({ log })({ method: 'GET', headers: {} }, res, jest.fn());
      res.emit('finish');
    }

    expect(log).toHaveBeenCalledTimes(2);
  });

  test('does not log for a successful response', () => {
    const log = jest.fn();
    const res = createRes(200);

    createSecurityAuditLogger({ log })({ method: 'GET', headers: {} }, res, jest.fn());
    res.emit('finish');

    expect(log).not.toHaveBeenCalled();
  });

  test('does not log for an unmonitored status code (e.g. 500)', () => {
    const log = jest.fn();
    const res = createRes(500);

    createSecurityAuditLogger({ log })({ method: 'GET', headers: {} }, res, jest.fn());
    res.emit('finish');

    expect(log).not.toHaveBeenCalled();
  });

  test('custom statusCodes list is honored', () => {
    const log = jest.fn();
    const res = createRes(404);

    createSecurityAuditLogger({ log, statusCodes: [404] })({ method: 'GET', headers: {} }, res, jest.fn());
    res.emit('finish');

    expect(log).toHaveBeenCalledTimes(1);
  });

  test('prefers X-Forwarded-For over the raw connection address', () => {
    const log = jest.fn();
    const res = createRes(401);
    const req = {
      method: 'GET',
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
      connection: { remoteAddress: '10.0.0.1' }
    };

    createSecurityAuditLogger({ log })(req, res, jest.fn());
    res.emit('finish');

    expect(log).toHaveBeenCalledWith('security_event', expect.objectContaining({ ip: '203.0.113.5' }));
  });

  test('always calls next() synchronously, regardless of the eventual response status', () => {
    const next = jest.fn();
    const res = createRes(401);

    createSecurityAuditLogger({ log: jest.fn() })({ method: 'GET', headers: {} }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
