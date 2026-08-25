const express = require('express');
const request = require('supertest');
const { createPlanCatalog, createFeatureGuard } = require('../src');

const catalog = createPlanCatalog({
  plans: { free: ['dashboard'], starter: ['dashboard', 'reports'], pro: ['dashboard', 'reports', 'analytics'] },
  labels: { free: 'Free', starter: 'Starter', pro: 'Pro' },
  upgradePath: { free: 'starter', starter: 'pro' }
});

function build({ account = { plan: 'starter' }, ...options } = {}) {
  const guard = createFeatureGuard({
    catalog,
    resolveAccount: typeof account === 'function' ? account : async () => account,
    ...options
  });

  const app = express();
  app.use((req, _res, next) => { req.user = { role: 'member' }; next(); });
  app.get('/reports', guard('reports'), (_req, res) => res.status(200).json({ ok: true }));
  app.get('/analytics', guard('analytics'), (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('feature guard', () => {
  test('lets a request through when the plan includes the feature', async () => {
    await request(build()).get('/reports').expect(200);
  });

  test('closes the door when it does not, and says which plan opens it', async () => {
    const response = await request(build()).get('/analytics').expect(403);

    expect(response.body.message).toMatch(/Starter/);
    expect(response.body.message).toMatch(/Pro/);
    expect(response.body.data).toMatchObject({ feature: 'analytics', currentPlan: 'starter', upgradeTo: 'pro', reason: 'plan' });
  });

  test('at the top plan it does not invent an upgrade to sell', async () => {
    const response = await request(build({ account: { plan: 'pro' } })).get('/analytics').expect(200);

    expect(response.body).toEqual({ ok: true });
  });

  test('an override opens one feature for one account', async () => {
    await request(build({ account: { plan: 'starter', overrides: ['analytics'] } })).get('/analytics').expect(200);
  });

  test('no account to bill means nothing to gate', async () => {
    await request(build({ account: null })).get('/analytics').expect(200);
  });

  test('an exempt role never meets the guard', async () => {
    const app = build({ account: { plan: 'free' }, isExempt: (req) => req.user.role === 'member' });

    await request(app).get('/analytics').expect(200);
  });

  test('the kill switch answers before the plan does', async () => {
    const app = build({ account: { plan: 'pro' }, isEnabled: async (feature) => feature !== 'analytics' });

    const response = await request(app).get('/analytics').expect(403);

    /* A feature down for maintenance is down for the plan that pays for it
       too — answering "upgrade" there would be a lie. */
    expect(response.body.data.reason).toBe('disabled');
    expect(response.body.message).not.toMatch(/[Uu]pgrade/);
  });

  test('by default a failed lookup CLOSES the door', async () => {
    const app = build({ account: async () => { throw new Error('database down'); } });

    const response = await request(app).get('/reports').expect(403);

    expect(response.body.data.reason).toBe('error');
  });

  test('a product may choose to stay open on failure, deliberately', async () => {
    const app = build({ account: async () => { throw new Error('database down'); }, onError: 'allow' });

    await request(app).get('/reports').expect(200);
  });

  test('the failure is reported, never swallowed silently', async () => {
    const seen = [];
    const app = build({
      account: async () => { throw new Error('database down'); },
      onErrorLog: (error, feature) => seen.push({ message: error.message, feature })
    });

    await request(app).get('/reports').expect(403);

    expect(seen).toEqual([{ message: 'database down', feature: 'reports' }]);
  });

  test('the response shape can be replaced to match an existing API', async () => {
    const app = build({
      account: { plan: 'free' },
      respond: (res, payload) => res.status(payload.status).send(payload.message)
    });

    const response = await request(app).get('/reports').expect(403);

    expect(response.text).toMatch(/not included in the Free plan/);
  });

  test('guarding an empty feature key is a wiring mistake', () => {
    const guard = createFeatureGuard({ catalog, resolveAccount: async () => null });

    expect(() => guard('')).toThrow(/non-empty feature key/);
  });

  test('wiring without a catalog or a resolver is refused up front', () => {
    expect(() => createFeatureGuard({ resolveAccount: async () => null })).toThrow(/catalog/);
    expect(() => createFeatureGuard({ catalog })).toThrow(/resolveAccount/);
  });
});
