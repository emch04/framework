const { AppError } = require('../src');

describe('AppError', () => {
  test('stores message, status code, and operational marker', () => {
    const error = new AppError('Not allowed', 403);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Not allowed');
    expect(error.statusCode).toBe(403);
    expect(error.isOperational).toBe(true);
  });
});
