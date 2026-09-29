const { createProviderRouter: createRouter } = require('../src');

/* Chaque routeur est arrêté, même quand une assertion échoue avant. */
const openRouters = [];
const createProviderRouter = (config) => {
  const router = createRouter(config);
  openRouters.push(router);
  return router;
};
afterEach(() => { openRouters.splice(0).forEach((router) => router.stop()); });

const failing = (status) => Object.assign(new Error(`answered ${status}`), { statusCode: status });

/* Un fournisseur dont chaque modèle répond selon `answers[modelId]` : une valeur, une erreur ou une fonction. */
function scriptedProvider(id, answers, extra = {}) {
  const asked = [];
  return {
    asked,
    provider: {
      id,
      models: [],
      async call(prompt, ctx, model) {
        asked.push(model.id);
        const answer = answers[model.id];
        const value = typeof answer === 'function' ? await answer(prompt, ctx, model) : answer;
        if (value instanceof Error) throw value;
        return value;
      },
      ...extra
    }
  };
}

describe('route: the order of one request, across providers', () => {
  test('request.candidates gives the order, across providers; the answer says who gave it', async () => {
    const a = scriptedProvider('a', { slow: 'from a' });
    const b = scriptedProvider('b', { quick: 'from b' });
    const router = createProviderRouter({ providers: [a.provider, b.provider] });
    const routed = await router.route('q', { candidates: [{ provider: 'b', model: 'quick' }, { provider: 'a', model: 'slow' }] });
    expect(routed).toEqual({ value: 'from b', provider: 'b', model: 'quick', key: 'b:quick', partial: false });
    expect(await router.ask('q', { candidates: [{ provider: 'nowhere', model: 'x' }, { provider: 'a', model: 'slow' }] })).toBe('from a');
  });

  test('a candidate brings its own fields to the provider (a model\'s switches), over those declared', async () => {
    let seen;
    const router = createProviderRouter({
      providers: [{ id: 'p', models: [{ id: 'm', rpm: 5, extra: { a: 1 } }], call: async (_prompt, _ctx, model) => { seen = model; return 'ok'; } }]
    });
    await router.ask('q', { candidates: [{ provider: 'p', model: 'm', extra: { b: 2 }, vision: true }] });
    expect(seen).toEqual({ id: 'm', rpm: 5, extra: { b: 2 }, vision: true });
  });

  test('a provider without its key is skipped silently; with none at all the error says so', async () => {
    const keyless = scriptedProvider('keyless', { m: 'never' }, { available: async () => false });
    const ready = scriptedProvider('ready', { m: 'ok' });
    const router = createProviderRouter({ providers: [keyless.provider, ready.provider] });
    const candidates = [{ provider: 'keyless', model: 'm' }, { provider: 'ready', model: 'm' }];
    expect(await router.ask('q', { candidates })).toBe('ok');
    expect(keyless.asked).toEqual([]);
    expect(router.getStats()['keyless:m']).toBeUndefined();
    await expect(router.ask('q', { candidates: [candidates[0]] })).rejects.toMatchObject({ statusCode: 503, code: 'AI_NO_PROVIDER' });
  });

  test('select keeps only the models fit for this request (a photo for the models that see)', async () => {
    const p = scriptedProvider('p', { blind: 'blind answer', seeing: 'seen' });
    const router = createProviderRouter({ providers: [p.provider] });
    const candidates = [{ provider: 'p', model: 'blind' }, { provider: 'p', model: 'seeing', vision: true }];
    expect(await router.ask('photo', { candidates, select: (model) => model.vision === true })).toBe('seen');
    expect(p.asked).toEqual(['seeing']);
    await expect(router.ask('photo', { candidates: [candidates[0]], select: (model) => model.vision === true }))
      .rejects.toMatchObject({ code: 'AI_NO_MATCH' });
  });

  test('an answer the caller does not accept hands over to the next model, and is no failure of the model', async () => {
    const p = scriptedProvider('p', { wrong: { toolCalls: [{ name: 'invented' }] }, right: { text: 'Bien.' } });
    const router = createProviderRouter({ providers: [p.provider] });
    const candidates = [{ provider: 'p', model: 'wrong' }, { provider: 'p', model: 'right' }];
    const accepts = (value) => Boolean(value.text);
    expect(await router.route('q', { candidates, accepts })).toMatchObject({ value: { text: 'Bien.' }, model: 'right' });
    expect(router.getStats()['p:wrong']).toMatchObject({ failures: 0, cooldown: false });
    const error = await router.ask('q', { candidates: [candidates[0]], accepts }).catch((e) => e);
    expect(error).toMatchObject({ code: 'AI_UNAVAILABLE', statusCode: 503 });
    expect(error.message).toMatch(/p:wrong gave a response that was not accepted/);
  });

  test('an answer cut short is kept as a last resort only: another model that finishes wins', async () => {
    const p = scriptedProvider('p', { short: { text: 'Coupé', cut: true }, whole: { text: 'Entier.' } });
    const router = createProviderRouter({ providers: [p.provider] });
    const partial = (value) => value.cut === true;
    expect(await router.ask('q', { candidates: [{ provider: 'p', model: 'short' }, { provider: 'p', model: 'whole' }], partial })).toEqual({ text: 'Entier.' });
    expect(await router.route('q', { candidates: [{ provider: 'p', model: 'short' }], partial }))
      .toEqual({ value: { text: 'Coupé', cut: true }, provider: 'p', model: 'short', key: 'p:short', partial: true });
  });
});

describe('route: resting', () => {
  test('cooldownOn decides what rests a model (a 503 or a timeout too), for cooldownMs, on the injected clock', async () => {
    let clock = 1_000_000;
    let busy = true;
    const p = scriptedProvider('p', { busy: () => (busy ? failing(503) : 'awake'), spare: 'spare' });
    const router = createProviderRouter({
      providers: [p.provider],
      now: () => clock,
      cooldownMs: 120_000,
      cooldownJitterMs: 0,
      cooldownOn: (error) => [429, 503].includes(error.statusCode) || error.name === 'TimeoutError'
    });
    const candidates = [{ provider: 'p', model: 'busy' }, { provider: 'p', model: 'spare' }];
    expect(await router.ask('q', { candidates })).toBe('spare');
    expect(await router.ask('q', { candidates })).toBe('spare');
    expect(p.asked).toEqual(['busy', 'spare', 'spare']);
    busy = false;
    clock += 121_000;
    expect(await router.ask('q', { candidates })).toBe('awake');
  });

  test('a 500 does not rest a model by default; a 429 does', async () => {
    const p = scriptedProvider('p', { broken: failing(500), limited: failing(429), ok: 'ok' });
    const router = createProviderRouter({ providers: [p.provider], cooldownJitterMs: 0 });
    await router.ask('q', { candidates: [{ provider: 'p', model: 'broken' }, { provider: 'p', model: 'limited' }, { provider: 'p', model: 'ok' }] });
    expect(router.getStats()['p:broken'].cooldown).toBe(false);
    expect(router.getStats()['p:limited'].cooldown).toBe(true);
  });

  test('whenAllCooling "try": when every candidate rests, they are all tried anyway', async () => {
    let calls = 0;
    const p = scriptedProvider('p', { only: () => (calls++ === 0 ? failing(429) : 'back') });
    const skip = createProviderRouter({ providers: [p.provider], cooldownJitterMs: 0 });
    await expect(skip.ask('q', { candidates: [{ provider: 'p', model: 'only' }] })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    await expect(skip.ask('q', { candidates: [{ provider: 'p', model: 'only' }] })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(calls).toBe(1);

    calls = 0;
    const tryAll = createProviderRouter({ providers: [p.provider], cooldownJitterMs: 0, whenAllCooling: 'try' });
    await expect(tryAll.ask('q', { candidates: [{ provider: 'p', model: 'only' }] })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(await tryAll.ask('q', { candidates: [{ provider: 'p', model: 'only' }] })).toBe('back');
  });

  test('a lane rests on its own: a saturated key for one use never stops the others', async () => {
    const p = scriptedProvider('p', { m: (_prompt, ctx) => (ctx.purpose === 'news' ? failing(429) : 'ok') }, { lane: (ctx) => (ctx.purpose === 'news' ? 'news' : null) });
    const router = createProviderRouter({ providers: [p.provider], cooldownJitterMs: 0 });
    const candidates = [{ provider: 'p', model: 'm' }];
    await expect(router.ask('q', { candidates }, { purpose: 'news' })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(await router.ask('q', { candidates }, { purpose: 'chat' })).toBe('ok');
    const stats = router.getStats();
    expect(stats['p:m@news'].cooldown).toBe(true);
    expect(stats['p:m'].cooldown).toBe(false);
  });

  test('reset forgets rests and failures', async () => {
    const p = scriptedProvider('p', { m: failing(429) });
    const router = createProviderRouter({ providers: [p.provider], cooldownJitterMs: 0 });
    await router.ask('q', { candidates: [{ provider: 'p', model: 'm' }] }).catch(() => {});
    expect(router.getStats()['p:m'].cooldown).toBe(true);
    router.reset();
    expect(router.getStats()['p:m'].cooldown).toBe(false);
  });
});

describe('route: the caller leaving', () => {
  test('a request abandoned by the caller stops at once, with the caller\'s reason, and rests nothing', async () => {
    const controller = new globalThis.AbortController();
    const p = scriptedProvider('p', {
      first: () => { controller.abort(Object.assign(new Error('left'), { name: 'AbortError' })); return failing(503); },
      second: 'never asked'
    });
    const router = createProviderRouter({ providers: [p.provider], cooldownOn: () => true });
    await expect(router.ask('q', { candidates: [{ provider: 'p', model: 'first' }, { provider: 'p', model: 'second' }] }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'left' });
    expect(p.asked).toEqual(['first']);
    expect(router.getStats()['p:first'].cooldown).toBe(false);
  });
});

describe('the midnight timer', () => {
  test('never keeps the process alive', () => {
    const spy = jest.spyOn(global, 'setTimeout');
    const router = createProviderRouter({ providers: [] });
    const timer = spy.mock.results.at(-1).value;
    spy.mockRestore();
    expect(typeof timer.hasRef === 'function' ? timer.hasRef() : false).toBe(false);
    router.stop();
  });
});
