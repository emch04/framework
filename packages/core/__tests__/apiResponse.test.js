const { apiResponse } = require('../src');

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

describe('apiResponse', () => {
  test('sends a standardized success payload with a timestamp', () => {
    const res = createResponse();

    const returned = apiResponse(res, 201, 'Created', { id: 'item-1' }, true);

    expect(returned).toBe(res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      message: 'Created',
      data: { id: 'item-1' }
    });
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
    expect(res.body).not.toHaveProperty('error');
  });

  test('adds an error alias when the payload is unsuccessful', () => {
    const res = createResponse();

    apiResponse(res, 400, 'Invalid input', { field: 'name' }, false);

    expect(res.body).toMatchObject({
      success: false,
      message: 'Invalid input',
      error: 'Invalid input',
      data: { field: 'name' }
    });
  });
});
