const { asyncHandler } = require('../src');

describe('asyncHandler', () => {
  test('passes rejected route errors to next', async () => {
    const error = new Error('boom');
    const next = jest.fn();
    const handler = asyncHandler(async () => {
      throw error;
    });

    await handler({}, {}, next);

    expect(next).toHaveBeenCalledWith(error);
  });

  test('does not call next when the wrapped route resolves', async () => {
    const next = jest.fn();
    const res = {};
    const handler = asyncHandler(async (req, response) => {
      response.value = req.value;
    });

    await handler({ value: 42 }, res, next);

    expect(res.value).toBe(42);
    expect(next).not.toHaveBeenCalled();
  });
});
