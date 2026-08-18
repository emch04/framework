const { createMongoSanitizeMiddleware } = require('../src');

function runMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    middleware(req, {}, (error) => (error ? reject(error) : resolve()));
  });
}

describe('createMongoSanitizeMiddleware', () => {
  test('strips a top-level $ operator key from req.query', async () => {
    const req = { query: { date: { $gt: '' } }, body: {}, params: {} };
    await runMiddleware(createMongoSanitizeMiddleware(), req);

    expect(req.query.date).toEqual({});
  });

  test('strips a dotted key', async () => {
    const req = { query: {}, body: { 'services.0.date': '2026-01-01' }, params: {} };
    await runMiddleware(createMongoSanitizeMiddleware(), req);

    expect(req.body).toEqual({});
  });

  test('recurses into nested objects and arrays', async () => {
    const req = {
      body: { filters: [{ ok: 'value' }, { $where: 'sabotage' }] },
      query: {},
      params: {}
    };
    await runMiddleware(createMongoSanitizeMiddleware(), req);

    expect(req.body.filters).toEqual([{ ok: 'value' }, {}]);
  });

  test('leaves ordinary requests completely untouched', async () => {
    const req = {
      query: { date: '2026-08-20', serviceIds: ['a', 'b'] },
      body: { nom: 'Jo', note: 5 },
      params: { id: 'abc123' }
    };
    const before = JSON.parse(JSON.stringify(req));
    await runMiddleware(createMongoSanitizeMiddleware(), req);

    expect(req).toEqual(before);
  });

  test('mutates req.query in place rather than reassigning it (getter-only safe)', async () => {
    const query = { date: { $ne: null } };
    const req = {
      body: {}, params: {},
      get query() { return query; }
      // no setter — reassigning req.query would throw; mutating query itself must not.
    };

    await expect(runMiddleware(createMongoSanitizeMiddleware(), req)).resolves.toBeUndefined();
    expect(query.date).toEqual({});
  });

  test('replaceWith keeps the offending value under a renamed key instead of dropping it', async () => {
    const req = { query: { date: { $gt: '' } }, body: {}, params: {} };
    await runMiddleware(createMongoSanitizeMiddleware({ replaceWith: '_blocked' }), req);

    expect(req.query.date).toEqual({ _blocked: '' });
  });

  test('only sanitizes the configured targets', async () => {
    const req = { query: { $where: 'x' }, body: { $where: 'y' }, params: {} };
    await runMiddleware(createMongoSanitizeMiddleware({ targets: ['query'] }), req);

    expect(req.query).toEqual({});
    expect(req.body).toEqual({ $where: 'y' });
  });

  test('calls next() exactly once and never throws on missing targets', async () => {
    const req = {};
    await expect(runMiddleware(createMongoSanitizeMiddleware(), req)).resolves.toBeUndefined();
  });
});
