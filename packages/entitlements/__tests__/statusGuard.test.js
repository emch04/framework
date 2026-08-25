const express = require('express');
const request = require('supertest');
const { createStatusGuard } = require('../src');

function build({ account = null, ...options } = {}) {
  const guard = createStatusGuard({
    resolveStatus: typeof account === 'function' ? account : async () => account,
    ...options
  });

  const app = express();
  app.use((req, _res, next) => { req.user = { role: 'member' }; next(); });
  app.get('/anything', guard, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('status guard', () => {
  test('an active account passes', async () => {
    await request(build({ account: { status: 'active' } })).get('/anything').expect(200);
  });

  test('nothing to suspend means nothing to block', async () => {
    await request(build({ account: null })).get('/anything').expect(200);
  });

  test('a suspended account is stopped, and told why', async () => {
    const app = build({ account: { status: 'suspended', name: 'Sainte-Marie', reason: 'unpaid invoice' } });

    const response = await request(app).get('/anything').expect(403);

    expect(response.body.message).toMatch(/Sainte-Marie/);
    expect(response.body.message).toMatch(/unpaid invoice/);
    expect(response.body.data).toEqual({ status: 'suspended', reason: 'unpaid invoice' });
  });

  test('the blocking statuses are the product\'s to choose', async () => {
    const app = build({ account: { status: 'archived' }, blockedStatuses: ['archived', 'closed'] });

    await request(app).get('/anything').expect(403);
  });

  test('a status not on the list passes, even an unusual one', async () => {
    await request(build({ account: { status: 'trialing' } })).get('/anything').expect(200);
  });

  test('an exempt role passes through a suspension', async () => {
    const app = build({
      account: { status: 'suspended' },
      isExempt: (req) => req.user.role === 'member'
    });

    await request(app).get('/anything').expect(200);
  });

  test('the message can be replaced entirely', async () => {
    const app = build({
      account: { status: 'suspended', name: 'X' },
      message: ({ status }) => `Compte ${status}. Contactez le support.`
    });

    const response = await request(app).get('/anything').expect(403);

    expect(response.body.message).toBe('Compte suspended. Contactez le support.');
  });

  test('by default a failed lookup closes the door', async () => {
    const app = build({ account: async () => { throw new Error('database down'); } });

    const response = await request(app).get('/anything').expect(403);

    expect(response.body.data.reason).toBe('error');
  });

  test('a product may choose to stay open on failure', async () => {
    const app = build({ account: async () => { throw new Error('database down'); }, onError: 'allow' });

    await request(app).get('/anything').expect(200);
  });

  test('wiring without a resolver is refused up front', () => {
    expect(() => createStatusGuard({})).toThrow(/resolveStatus/);
  });
});
