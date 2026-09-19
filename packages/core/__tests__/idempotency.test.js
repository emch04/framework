const { EventEmitter } = require('events');
const {
  createIdempotency,
  createMemoryIdempotencyStore,
  idempotencyMiddleware,
  decideIdempotency,
  hashIdempotencyPayload,
  isValidIdempotencyKey,
  IdempotencyError,
  IDEMPOTENCY_TTL_MS
} = require('../src');

const KEY = 'intent-0001';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function build(overrides = {}) {
  const store = overrides.store || createMemoryIdempotencyStore();
  const engine = createIdempotency({ store, ...overrides });
  return { store, engine };
}

describe('the engine — one intention, one execution', () => {
  test('a replay runs NOTHING and receives the first answer', async () => {
    /* The double tap on "Pay": two payments is the bug this file exists for. */
    const { engine } = build();
    const pay = jest.fn(async () => ({ paymentId: 'p-1' }));

    const first = await engine.run({ scope: ['u1'], key: KEY, payload: { amount: 10 } }, pay);
    const second = await engine.run({ scope: ['u1'], key: KEY, payload: { amount: 10 } }, pay);

    expect(pay).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ replayed: false, result: { paymentId: 'p-1' } });
    expect(second).toEqual({ replayed: true, result: { paymentId: 'p-1' } });
  });

  test('the same key with a different payload is refused (422), not served the other answer', async () => {
    const { engine } = build();
    await engine.run({ scope: ['u1'], key: KEY, payload: { amount: 10 } }, async () => 'ok');

    await expect(engine.run({ scope: ['u1'], key: KEY, payload: { amount: 99 } }, async () => 'other'))
      .rejects.toMatchObject({ reason: 'conflict', statusCode: 422 });
  });

  test('a missing payload does not slip past the comparison', async () => {
    /* Comparing "only when both sides have a hash" let a body-less request
       collect the stored answer of a request it never made. */
    const { engine } = build();
    await engine.run({ scope: ['u1'], key: KEY, payload: { amount: 10 } }, async () => 'secret');

    await expect(engine.run({ scope: ['u1'], key: KEY }, async () => 'x'))
      .rejects.toMatchObject({ reason: 'conflict' });
  });

  test('key order in the payload is not a different intention', () => {
    expect(hashIdempotencyPayload({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(hashIdempotencyPayload({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashIdempotencyPayload({ a: 1 })).not.toBe(hashIdempotencyPayload({ a: 2 }));
  });

  test('two SIMULTANEOUS requests with the same key: exactly one runs', async () => {
    const { engine } = build();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const work = jest.fn(async () => { await gate; return 'done'; });

    const first = engine.run({ scope: ['u1'], key: KEY, payload: 1 }, work);
    const second = engine.run({ scope: ['u1'], key: KEY, payload: 1 }, work);

    await expect(second).rejects.toMatchObject({ reason: 'in_flight', statusCode: 409 });
    release();
    await expect(first).resolves.toEqual({ replayed: false, result: 'done' });
    expect(work).toHaveBeenCalledTimes(1);
  });

  test('ten racing requests: one execution', async () => {
    const { engine } = build();
    const work = jest.fn(async () => { await tick(); return 'ok'; });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => engine.run({ scope: ['u1'], key: KEY, payload: 1 }, work))
    );

    expect(work).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });

  test('two accounts sending the same key never share an answer', async () => {
    const { engine } = build();
    await engine.run({ scope: ['u1'], key: KEY, payload: 1 }, async () => 'for u1');

    const other = await engine.run({ scope: ['u2'], key: KEY, payload: 1 }, async () => 'for u2');
    expect(other).toEqual({ replayed: false, result: 'for u2' });
  });

  test('a failure releases the key: the retry runs for real', async () => {
    /* A stored failure would turn a passing outage into a permanent refusal. */
    const { engine, store } = build();
    await expect(engine.run({ scope: ['u1'], key: KEY, payload: 1 }, async () => { throw new Error('db down'); }))
      .rejects.toThrow('db down');
    expect(store.size()).toBe(0);

    const retry = await engine.run({ scope: ['u1'], key: KEY, payload: 1 }, async () => 'ok');
    expect(retry.replayed).toBe(false);
  });

  test('a result the caller does not want remembered releases the key too', async () => {
    const { engine, store } = build();
    await engine.run({ scope: ['u1'], key: KEY, payload: 1 }, async () => ({ statusCode: 500 }), {
      remember: (r) => r.statusCode < 300
    });
    expect(store.size()).toBe(0);
  });

  test('after the retention, the key is a new intention', async () => {
    let clock = 0;
    const { engine } = build({ ttlMs: 1000, now: () => clock, store: createMemoryIdempotencyStore({ now: () => clock }) });
    const work = jest.fn(async () => 'ok');

    await engine.run({ scope: ['u1'], key: KEY, payload: 1 }, work);
    clock = 1000;
    const later = await engine.run({ scope: ['u1'], key: KEY, payload: 1 }, work);

    expect(later.replayed).toBe(false);
    expect(work).toHaveBeenCalledTimes(2);
  });

  test('an expired record the store has NOT purged yet does not block the key', async () => {
    /* A TTL index purges on its own schedule. Until then, the insert fails on
       the lingering record — which used to answer "in progress" for a request
       that was not. */
    let clock = 0;
    const lazyStore = createMemoryIdempotencyStore({ now: () => 0 }); // never purges
    const { engine } = build({ ttlMs: 1000, now: () => clock, store: lazyStore });

    await engine.run({ scope: ['u1'], key: KEY, payload: 1 }, async () => 'old');
    clock = 5000;
    const fresh = await engine.run({ scope: ['u1'], key: KEY, payload: 2 }, async () => 'new');

    expect(fresh).toEqual({ replayed: false, result: 'new' });
  });

  test('releasing an expired record never deletes a fresh one claimed meanwhile', async () => {
    /* Two retries find the same expired record at once. Each releases it — but
       a release keyed on the id alone lets the slower one delete the record
       the faster one just claimed, and both run. */
    let clock = 0;
    const store = createMemoryIdempotencyStore({ now: () => 0 }); // never purges
    const { engine } = build({ store, ttlMs: 1000, now: () => clock });
    await engine.run({ scope: ['u1'], key: KEY, payload: 1 }, async () => 'old');
    clock = 5000;

    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const work = jest.fn(async () => { await gate; return 'new'; });
    const settled = Promise.allSettled([1, 2, 3].map(() => engine.run({ scope: ['u1'], key: KEY, payload: 1 }, work)));
    await tick();
    open();
    const outcomes = await settled;

    expect(work).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });

  test('a slow release of the expired record cannot delete the fresh claim', async () => {
    /* Deterministic version of the race above: the second retry's release
       lands AFTER the first one has already re-claimed the key. */
    let clock = 0;
    const inner = createMemoryIdempotencyStore({ now: () => 0 });
    let releases = 0;
    let letSecondRelease;
    const secondGate = new Promise((resolve) => { letSecondRelease = resolve; });
    const store = {
      ...inner,
      async release(id, token) {
        releases += 1;
        if (releases === 2) await secondGate;
        return inner.release(id, token);
      }
    };
    const { engine } = build({ store, ttlMs: 1000, now: () => clock });
    await engine.run({ scope: ['u1'], key: KEY, payload: 1 }, async () => 'old');
    clock = 5000;

    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const work = jest.fn(async () => { await gate; return 'new'; });
    const settled = Promise.allSettled([1, 2].map(() => engine.run({ scope: ['u1'], key: KEY, payload: 1 }, work)));
    await tick();
    letSecondRelease();
    await tick();
    open();
    const outcomes = await settled;

    expect(work).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  test('the retention is injected and validated', () => {
    expect(build().engine.ttlMs).toBe(IDEMPOTENCY_TTL_MS);
    expect(build({ ttlMs: 60_000 }).engine.ttlMs).toBe(60_000);
    expect(() => build({ ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => createIdempotency({ store: {} })).toThrow(/acquire/);
  });

  test('a store failure AFTER the work ran is logged, not thrown', async () => {
    /* The payment went through; reporting it as failed invites a second one. */
    const store = createMemoryIdempotencyStore();
    store.complete = async () => { throw new Error('write lost'); };
    const logger = { error: jest.fn(), warn: jest.fn() };
    const { engine } = build({ store, logger });

    await expect(engine.run({ scope: ['u1'], key: KEY, payload: 1 }, async () => 'paid'))
      .resolves.toEqual({ replayed: false, result: 'paid' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('the key itself', () => {
  test('long enough to be unique, with an alphabet safe for a query', () => {
    expect(isValidIdempotencyKey('abcdefgh')).toBe(true);
    expect(isValidIdempotencyKey('short')).toBe(false);
    expect(isValidIdempotencyKey('../../etc/passwd')).toBe(false);
    expect(isValidIdempotencyKey({ $ne: null })).toBe(false);
    expect(isValidIdempotencyKey('a'.repeat(129))).toBe(false);
  });

  test('an invalid key is refused before touching the store', async () => {
    const { engine, store } = build();
    await expect(engine.begin({ scope: ['u1'], key: 'bad key!', payload: 1 }))
      .rejects.toBeInstanceOf(IdempotencyError);
    expect(store.size()).toBe(0);
  });

  test('the decision is pure', () => {
    const record = { status: 'done', payloadHash: 'h', expiresAt: 100, response: 'r' };
    expect(decideIdempotency({ record: null, payloadHash: 'h', now: 0 }).action).toBe('execute');
    expect(decideIdempotency({ record, payloadHash: 'h', now: 0 })).toEqual({ action: 'replay', response: 'r' });
    expect(decideIdempotency({ record, payloadHash: 'x', now: 0 }).action).toBe('conflict');
    expect(decideIdempotency({ record: { ...record, status: 'in_flight' }, payloadHash: 'h', now: 0 }).action).toBe('inFlight');
    expect(decideIdempotency({ record, payloadHash: 'h', now: 100 }).action).toBe('expired');
  });
});

/* ───────────────────────────── Express ───────────────────────────── */

function createResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
  res.sent = 0;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.sent += 1; res.emit('finish'); return res; };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  return res;
}

function request(overrides = {}) {
  return {
    method: 'POST',
    originalUrl: '/api/payments?x=1',
    headers: { 'idempotency-key': KEY },
    body: { amount: 10 },
    user: { id: 'u1' },
    ...overrides
  };
}

function app(options = {}) {
  const store = options.store || createMemoryIdempotencyStore();
  const handler = options.handler || jest.fn((req, res) => { res.status(201).json({ paymentId: 'p-1' }); });
  const middleware = idempotencyMiddleware({ store, identify: (req) => req.user && req.user.id, ...options });
  async function send(req) {
    const res = createResponse();
    await middleware(req, res, (error) => { if (error) throw error; return handler(req, res); });
    await tick();
    return res;
  }
  return { send, handler, store };
}

describe('idempotencyMiddleware', () => {
  test('a replayed request is not executed twice and receives the same answer', async () => {
    const { send, handler } = app();

    const first = await send(request());
    const second = await send(request());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['Idempotent-Replay']).toBe('true');
  });

  test('the answer is recorded BEFORE it leaves: an instant retry is a replay, not a 409', async () => {
    const store = createMemoryIdempotencyStore();
    const complete = store.complete;
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    store.complete = async (...args) => { await gate; return complete(...args); };
    const middleware = idempotencyMiddleware({ store, identify: (req) => req.user.id });
    const res = createResponse();

    await middleware(request(), res, () => res.status(201).json({ ok: true }));
    await tick();
    expect(res.sent).toBe(0);

    open();
    await tick();
    expect(res.sent).toBe(1);
    expect(res.body).toEqual({ ok: true });
  });

  test('the same key with another body is refused with 422', async () => {
    const { send, handler } = app();
    await send(request());

    const res = await send(request({ body: { amount: 999 } }));

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ success: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('two simultaneous requests: one runs, the other gets 409', async () => {
    let finish;
    const handler = jest.fn((req, res) => { finish = () => res.status(201).json({ ok: true }); });
    const { send } = app({ handler });

    const first = send(request());
    await tick();
    const second = await send(request());
    finish();
    await first;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.statusCode).toBe(409);
  });

  test('without the header, nothing changes — idempotency is offered, not imposed', async () => {
    const { send, handler, store } = app();
    await send(request({ headers: {} }));
    await send(request({ headers: {} }));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.size()).toBe(0);
  });

  test('reads pass through even with a key', async () => {
    const { send, handler } = app();
    await send(request({ method: 'GET' }));
    await send(request({ method: 'GET' }));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('an error answer is not kept: the corrected retry runs', async () => {
    let fail = true;
    const handler = jest.fn((req, res) => res.status(fail ? 503 : 201).json({ ok: !fail }));
    const { send, store } = app({ handler });

    await send(request());
    expect(store.size()).toBe(0);
    fail = false;
    const retry = await send(request());

    expect(handler).toHaveBeenCalledTimes(2);
    expect(retry.statusCode).toBe(201);
  });

  test('the caller is part of the key: another account runs its own request', async () => {
    const { send, handler } = app();
    await send(request());
    const other = await send(request({ user: { id: 'u2' } }));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(other.headers['Idempotent-Replay']).toBeUndefined();
  });

  test('the query string is not part of the intention', async () => {
    const { send, handler } = app();
    await send(request());
    await send(request({ originalUrl: '/api/payments?x=2' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('an invalid key is refused with 400', async () => {
    const { send, handler } = app();
    const res = await send(request({ headers: { 'idempotency-key': 'x' } }));
    expect(res.statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  test('store down: 503 by default — the duplicate is what we are here to prevent', async () => {
    const store = createMemoryIdempotencyStore();
    store.acquire = async () => { throw new Error('connection refused'); };
    const { send, handler } = app({ store });

    const res = await send(request());
    expect(res.statusCode).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  test("store down with onStoreError 'allow': the request runs unguarded", async () => {
    const store = createMemoryIdempotencyStore();
    store.acquire = async () => { throw new Error('connection refused'); };
    const { send, handler } = app({ store, onStoreError: 'allow' });

    await send(request());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('messages and the refusal shape are injected', async () => {
    const respond = jest.fn((res, payload) => res.status(payload.status).json({ code: payload.reason, text: payload.message }));
    const { send } = app({ respond, messages: { conflict: 'Clé déjà utilisée.' } });
    await send(request());
    const res = await send(request({ body: { amount: 1 } }));
    expect(res.body).toEqual({ code: 'conflict', text: 'Clé déjà utilisée.' });
  });

  test('identify is required — a middleware that guesses the caller mixes accounts', () => {
    expect(() => idempotencyMiddleware({ store: createMemoryIdempotencyStore() })).toThrow(/identify/);
  });

  test('a response sent without res.json still settles the key on finish', async () => {
    const handler = jest.fn((req, res) => { res.statusCode = 204; res.emit('finish'); });
    const { send } = app({ handler });

    await send(request());
    const retry = await send(request());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(retry.statusCode).toBe(204);
  });
});
