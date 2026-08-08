const { createWafMiddleware } = require('../src');

const createRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

describe('waf', () => {
  test.each([
    ['SQL injection', { path: '/users', query: { q: 'select * from users' }, body: {} }],
    ['XSS', { path: '/search', query: {}, body: { name: '<script>alert(1)</script>' } }],
    ['path traversal', { path: '/files/../../../../etc/passwd', query: {}, body: {} }]
  ])('blocks %s patterns', (name, req) => {
    const res = createRes();
    const next = jest.fn();

    createWafMiddleware()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows normal requests', () => {
    const req = { path: '/users', query: { q: 'alice' }, body: { active: true } };
    const next = jest.fn();

    createWafMiddleware()(req, createRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('uses custom message when blocked', () => {
    const res = createRes();

    createWafMiddleware({ message: { error: 'denied' } })(
      { path: '/x', query: {}, body: { value: 'javascript:alert(1)' } },
      res,
      jest.fn()
    );

    expect(res.json).toHaveBeenCalledWith({ error: 'denied' });
  });
});
