const { body } = require('express-validator');
const { validateMiddleware } = require('../src');

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

describe('validateMiddleware', () => {
  test('returns 400 with validation errors when a request is invalid', async () => {
    const req = { body: { email: 'bad-email' } };
    const res = createResponse();
    const next = jest.fn();
    const middleware = validateMiddleware([
      body('email').isEmail().withMessage('Email must be valid')
    ]);

    await middleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Validation failed',
      error: 'Validation failed'
    });
    expect(res.body.data.errors).toEqual([
      expect.objectContaining({
        path: 'email',
        msg: 'Email must be valid'
      })
    ]);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next when all validations pass', async () => {
    const req = { body: { email: 'person@example.com' } };
    const res = createResponse();
    const next = jest.fn();
    const middleware = validateMiddleware([body('email').isEmail()]);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.body).toBeUndefined();
  });
});
