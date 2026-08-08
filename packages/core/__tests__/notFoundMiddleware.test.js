const { notFoundMiddleware } = require('../src');

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

describe('notFoundMiddleware', () => {
  test('returns a generic 404 JSON response with the requested path', () => {
    const res = createResponse();

    notFoundMiddleware({ originalUrl: '/missing' }, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Route not found',
      error: 'Route not found',
      data: { path: '/missing' }
    });
  });
});
