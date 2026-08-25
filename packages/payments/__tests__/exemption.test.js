const express = require('express');
const request = require('supertest');
const { createWebhookExemption, createWebhookHandler } = require('../src');

describe('webhook exemption', () => {
  test('matches an exact path', () => {
    const isWebhook = createWebhookExemption({ paths: ['/api/payments/webhook'] });

    expect(isWebhook('/api/payments/webhook')).toBe(true);
    expect(isWebhook('/api/payments/checkout')).toBe(false);
  });

  test('prefix AND suffix together keep the exemption to the webhook itself', () => {
    const isWebhook = createWebhookExemption({ prefix: '/api/finance/', suffix: '/webhook' });

    expect(isWebhook('/api/finance/school-subscription/webhook')).toBe(true);
    expect(isWebhook('/api/finance/parent-subscription/webhook')).toBe(true);
    /* A prefix alone would have exempted this too — an entire billing section
       left without CSRF or auth. */
    expect(isWebhook('/api/finance/transfer')).toBe(false);
  });

  test('a suffix alone catches every webhook wherever it lives', () => {
    const isWebhook = createWebhookExemption({ suffix: '/webhook' });

    expect(isWebhook('/anything/at/all/webhook')).toBe(true);
    expect(isWebhook('/webhook/replay')).toBe(false);
  });

  test('a query string does not break the match', () => {
    const isWebhook = createWebhookExemption({ suffix: '/webhook' });

    expect(isWebhook('/api/payments/webhook?retry=1')).toBe(true);
  });

  test('reads the path from a request object, whichever field carries it', () => {
    const isWebhook = createWebhookExemption({ suffix: '/webhook' });

    expect(isWebhook({ path: '/api/payments/webhook' })).toBe(true);
    expect(isWebhook({ originalUrl: '/api/payments/webhook?x=1' })).toBe(true);
    expect(isWebhook({ url: '/api/payments/webhook' })).toBe(true);
    expect(isWebhook({})).toBe(false);
    expect(isWebhook(null)).toBe(false);
  });

  test('a pattern covers what the simple forms cannot', () => {
    const isWebhook = createWebhookExemption({ pattern: /^\/hooks\/[a-z]+$/ });

    expect(isWebhook('/hooks/stripe')).toBe(true);
    expect(isWebhook('/hooks/stripe/replay')).toBe(false);
  });

  test('an exemption that matches nothing is a wiring mistake', () => {
    expect(() => createWebhookExemption({})).toThrow(/at least one/);
  });
});

describe('crossing a real middleware stack', () => {
  /**
   * The scenario that costs real money: a JSON parser rewrites the signed
   * bytes, and CSRF answers 403 to a caller that has no cookie to send. One
   * predicate, shared by both, is what keeps them consistent.
   */
  function buildApp({ exempt }) {
    const isWebhook = createWebhookExemption({ suffix: '/webhook' });
    const app = express();

    app.use((req, res, next) => {
      if (exempt && isWebhook(req)) return next();
      return express.json()(req, res, next);
    });

    app.use((req, res, next) => {
      if (exempt && isWebhook(req)) return next();
      return res.status(403).json({ error: 'csrf' });
    });

    const handler = createWebhookHandler({
      verify: ({ payload }) => {
        /* A signature check works on BYTES. Anything that re-encoded the body
           on the way in shows up here, and only here. */
        if (!Buffer.isBuffer(payload)) throw new Error('raw body was consumed before it reached the signature check');
        return JSON.parse(payload.toString());
      },
      secret: 'whsec_test',
      events: { 'checkout.session.completed': async () => {} }
    });

    app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), handler.middleware);
    return app;
  }

  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });

  test('with the exemption, the event gets through with its bytes intact', async () => {
    const response = await request(buildApp({ exempt: true }))
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ received: true, status: 'handled' });
  });

  test('without it, CSRF answers 403 to a provider that has no cookie', async () => {
    const response = await request(buildApp({ exempt: false }))
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(response.status).toBe(403);
  });
});
