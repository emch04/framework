const { AppError, errorMiddleware } = require('../src');

function createResponse() {
  return {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

describe('errorMiddleware', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('serializes AppError with its status code', () => {
    const res = createResponse();

    errorMiddleware(new AppError('Invalid token', 401), {}, res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Invalid token',
      error: 'Invalid token'
    });
  });

  test('hides unexpected server error details in production', () => {
    process.env.NODE_ENV = 'production';
    const res = createResponse();

    errorMiddleware(new Error('database password leaked'), {}, res, jest.fn());

    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe('Internal server error');
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.data).toBeNull();
  });

  test('includes stack trace in development', () => {
    process.env.NODE_ENV = 'development';
    const res = createResponse();

    errorMiddleware(new Error('broken'), {}, res, jest.fn());

    expect(res.body.message).toBe('broken');
    expect(res.body.data.stack).toContain('Error: broken');
  });

  test('logs server errors via req.log when available', () => {
    process.env.NODE_ENV = 'production';
    const res = createResponse();
    const req = { requestId: 'abc-123', log: { error: jest.fn() } };

    errorMiddleware(new Error('db down'), req, res, jest.fn());

    expect(req.log.error).toHaveBeenCalledWith(
      expect.stringContaining('abc-123'),
      expect.any(Error)
    );
  });

  test('does not log client errors (4xx)', () => {
    process.env.NODE_ENV = 'production';
    const res = createResponse();
    const req = { log: { error: jest.fn() } };

    errorMiddleware(new AppError('Invalid token', 401), req, res, jest.fn());

    expect(req.log.error).not.toHaveBeenCalled();
  });
});
