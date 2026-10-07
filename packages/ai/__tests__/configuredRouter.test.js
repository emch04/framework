const { createConfiguredRouter, createMemoryRoutingStore, estimateRequestComplexity, estimateRequestTokens, readAiConfigFromEnv, readEnvironmentKeys } = require('../src');
const { httpFixture, json, chat } = require('./httpFixture');

let fixture;
let handle;
beforeEach(async () => { handle = ({ res, body }) => chat(res, body.model); fixture = await httpFixture((args) => handle(args)); });
afterEach(async () => { await fixture?.close(); });
const provider = (models = ['fast', 'chat', 'pilot', 'json', 'vision']) => ({ id: 'cloud', format: 'openai', url: fixture.url, keys: ['test-one'], models: models.map((id) => ({ id, vision: id === 'vision' })) });
const lists = Object.fromEntries(['quick', 'chat', 'tools', 'json', 'vision'].map((usage, index) => [usage, [{ provider: 'cloud', model: ['fast', 'chat', 'pilot', 'json', 'vision'][index] }]]));
const request = (text = 'hello', extra = {}) => ({ messages: [{ role: 'user', text }], ...extra });

test.each(['quick', 'chat', 'tools', 'json', 'vision'])('chooses configured usage %s', async (usage) => {
  const router = createConfiguredRouter({ providers: [provider()], usages: lists });
  const result = await router.route(request(), { usage });
  expect(result.value.text).toBe(lists[usage][0].model);
  expect(result.usage).toBe(usage);
  expect(result.provider).toBe('cloud');
  expect(result.key).toContain('@key-1');
});

test('complexity mirrors Oracle and infers quick, chat, tools and explicit JSON', async () => {
  const router = createConfiguredRouter({ providers: [provider()], usages: lists });
  expect(estimateRequestComplexity('bonjour')).toBe('simple');
  expect(estimateRequestComplexity('explique ce mot')).toBe('medium');
  expect(estimateRequestComplexity('analyse les causes')).toBe('complex');
  expect(estimateRequestComplexity('word '.repeat(41))).toBe('complex');
  expect((await router.route('hello')).model).toBe('fast');
  expect((await router.route('explain this')).model).toBe('chat');
  expect((await router.route(request('hello', { tools: [{ name: 'read' }] }))).model).toBe('pilot');
  expect((await router.route('hello', { json: true })).model).toBe('json');
  expect(estimateRequestTokens(request('hello', { system: 's', maxTokens: 20 }))).toBeGreaterThan(20);
});

test('intent precedes complexity; preview is last; disabled, languages and context limits are respected', async () => {
  const p = provider(['large', 'fast', 'preview', 'disabled', 'short']);
  p.models[0].complexity = ['complex']; p.models[1].complexity = ['simple']; p.models[2].preview = true;
  p.models[3].disabled = true; p.models[4].maxInputTokens = 1;
  const router = createConfiguredRouter({ providers: [p], intentRouting: { report: { preferred: ['cloud:large'] } } });
  expect((await router.route('hi')).model).toBe('fast');
  expect((await router.route('hi', { intent: 'report' })).model).toBe('large');
  p.models[0].languages = ['en']; p.models[1].languages = ['en'];
  expect((await router.route('hi', { language: 'fr' })).model).toBe('preview');
});

test('vision is filtered across all usages; incapable providers never receive images', async () => {
  const router = createConfiguredRouter({ providers: [provider()], usages: { chat: [...lists.chat, ...lists.vision] } });
  const result = await router.route({ messages: [{ role: 'user', text: 'photo', images: [{ mimeType: 'image/png', data: 'AA==' }] }] }, { usage: 'chat' });
  expect(result.model).toBe('vision');
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0].body.messages[0].content[1].image_url.url).toContain('image/png');
  await expect(router.route(request('photo', { messages: [{ role: 'user', images: [{}] }] }), { candidates: lists.chat })).rejects.toMatchObject({ code: 'AI_NO_MATCH' });
});

test('visionOnly is reserved for photos when enabled', async () => {
  const p = provider(['reserved', 'text']); p.models[0].visionOnly = true;
  const router = createConfiguredRouter({ providers: [p], reserveVision: true });
  expect((await router.route('hi')).model).toBe('text');
});

test('OpenAI extras merge by provider, model and request candidate', async () => {
  const p = provider(['m']); p.extra = { top_p: 0.9, include_reasoning: true }; p.models[0].extra = { include_reasoning: false };
  const router = createConfiguredRouter({ providers: [p] });
  await router.route('hi', { candidates: [{ provider: 'cloud', model: 'm', extra: { reasoning_format: 'hidden' } }] });
  expect(fixture.requests[0].body).toMatchObject({ top_p: 0.9, include_reasoning: false, reasoning_format: 'hidden' });
});

test('Gemini extras, instructions and explicit vision capability use the same router', async () => {
  handle = ({ res }) => json(res, { candidates: [{ content: { parts: [{ text: 'gemini' }] } }] });
  const router = createConfiguredRouter({ providers: [{ ...provider(['gem']), format: 'gemini', vision: true, extra: { safetySettings: [] }, models: [{ id: 'gem', extra: { generationConfig: { temperature: 0.1 } } }] }] });
  const result = await router.route(request('see', { system: 'system', messages: [{ role: 'user', text: 'see', images: [{ mimeType: 'image/png', data: 'AA==' }] }] }));
  expect(result.value.text).toBe('gemini');
  expect(fixture.requests[0].path).toBe('/gem:generateContent');
  expect(fixture.requests[0].body).toMatchObject({ generationConfig: { temperature: 0.1 }, safetySettings: [], systemInstruction: { parts: [{ text: 'system' }] } });
});

test('rotates keys and retries another key after 429, without leaking keys', async () => {
  handle = ({ res, req, body }) => req.headers.authorization.endsWith('one') ? json(res, {}, 429) : chat(res, body.model);
  const p = provider(['m']); p.keys = ['test-one', 'test-two'];
  const router = createConfiguredRouter({ providers: [p] });
  expect((await router.route('hi')).key).toBe('cloud:m@key-2');
  expect(fixture.requests.map((r) => r.headers.authorization)).toEqual(['Bearer test-one', 'Bearer test-two']);
  await router.route('hi');
  expect(JSON.stringify(await router.getStats())).not.toContain('test-one');
  expect((await router.getStats())['cloud:m@key-1'].cooldownUntil).toBeGreaterThan(0);
});

test('rotates healthy keys and re-reads injected keys each request', async () => {
  let keys = ['test-one', 'test-two'];
  const p = provider(['m']); p.keys = () => keys;
  const router = createConfiguredRouter({ providers: [p] });
  await router.route('hi'); await router.route('hi'); keys = ['test-new']; await router.route('hi');
  expect(fixture.requests.map((r) => r.headers.authorization)).toEqual(['Bearer test-one', 'Bearer test-two', 'Bearer test-new']);
});

test.each(['rpm', 'rpd', 'tpd'])('enforces %s margins and shares atomic reservations between routers', async (quota) => {
  const p = provider(['m']); p.models[0][quota] = quota === 'tpd' ? 12 : 2;
  const store = createMemoryRoutingStore();
  const a = createConfiguredRouter({ providers: [p], store, tokenBuffer: 1 });
  const b = createConfiguredRouter({ providers: [p], store, tokenBuffer: 1 });
  const results = await Promise.allSettled([a.route('hi', { estimatedTokens: 8 }), b.route('hi', { estimatedTokens: 8 })]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(fixture.requests).toHaveLength(1);
});

test('zero and fractional quota limits are never interpreted as unlimited', async () => {
  const p = provider(['m']); p.models[0].rpm = 1;
  await expect(createConfiguredRouter({ providers: [p] }).route('hi')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  p.models[0].rpm = 0;
  await expect(createConfiguredRouter({ providers: [p] }).route('hi')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  expect(fixture.requests).toHaveLength(0);
});

test('RPM slides at 60 seconds, daily quotas reset on the injected UTC day', async () => {
  let time = Date.parse('2026-10-08T23:59:00Z');
  const p = provider(['m']); p.models[0].rpm = 2; p.models[0].rpd = 2;
  const router = createConfiguredRouter({ providers: [p], now: () => time });
  await router.route('hi');
  await expect(router.route('hi')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  time += 60000;
  await router.route('hi');
  expect((await router.getStats())['cloud:m@key-1'].rpdUsed).toBe(1);
});

test.each([429, 503])('rests on HTTP %i and wakes after the cooldown', async (status) => {
  let time = 1000;
  handle = ({ res }) => json(res, {}, status);
  const router = createConfiguredRouter({ providers: [provider(['m'])], now: () => time, cooldownMs: 100 });
  await expect(router.route('hi')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  handle = ({ res }) => chat(res);
  await expect(router.route('hi')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  expect(fixture.requests).toHaveLength(1);
  time += 101;
  await router.route('hi');
});

test('three failures exclude the model for five minutes; 400 does not penalize it', async () => {
  let time = 1000;
  handle = ({ res }) => json(res, {}, 500);
  const router = createConfiguredRouter({ providers: [provider(['m'])], now: () => time });
  for (let at = 0; at < 3; at++) await expect(router.route('hi')).rejects.toBeDefined();
  handle = ({ res }) => chat(res);
  await expect(router.route('hi')).rejects.toBeDefined();
  expect(fixture.requests).toHaveLength(3);
  time += 300001; await router.route('hi');
  expect((await router.getStats())['cloud:m@key-1'].failures).toBe(0);
  handle = ({ res }) => json(res, {}, 400);
  await expect(router.route('hi')).rejects.toBeDefined();
  expect((await router.getStats())['cloud:m@key-1'].failures).toBe(0);
});

test('404 stays excluded until reset; all-cooling try never bypasses quotas or degradation', async () => {
  handle = ({ res }) => json(res, {}, 404);
  const router = createConfiguredRouter({ providers: [provider(['m'])], whenAllCooling: 'try' });
  await expect(router.route('hi')).rejects.toBeDefined();
  handle = ({ res }) => chat(res); await expect(router.route('hi')).rejects.toBeDefined();
  expect(fixture.requests).toHaveLength(1);
  await router.reset(); await router.route('hi');
});

test('different deadlines for waited and background calls, timeout rests, caller abort never rests', async () => {
  handle = () => {};
  const p = provider(['m']);
  const router = createConfiguredRouter({ providers: [p], waitedTimeoutMs: 15, backgroundTimeoutMs: 35 });
  await expect(router.route('hi')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  expect((await router.getStats())['cloud:m@key-1'].cooldownUntil).toBeGreaterThan(Date.now());
  await router.reset();
  const controller = new globalThis.AbortController(); setTimeout(() => controller.abort(new Error('left')), 5);
  await expect(router.route('hi', { waitedOn: false, signal: controller.signal })).rejects.toThrow('left');
  expect((await router.getStats())['cloud:m@key-1'].failures).toBe(0);
});

test('falls back without tools, retains read evidence and does not execute a new tool', async () => {
  handle = ({ res, body }) => body.tools ? json(res, {}, 400) : chat(res, 'read evidence');
  const router = createConfiguredRouter({ providers: [provider()], usages: lists });
  const result = await router.route(request('answer', { tools: [{ name: 'read' }], messages: [{ role: 'tool', name: 'read', toolCallId: '1', result: 'evidence' }] }));
  expect(result.fallback).toBe(true); expect(result.model).toBe('chat');
  expect(fixture.requests[1].body.tools).toBeUndefined();
  expect(fixture.requests[1].body.messages[0].content).toBe('evidence');
});

test('rejects unknown tools and partial answers finish with whole sentences', async () => {
  handle = ({ res, body }) => body.model === 'pilot' ? json(res, { choices: [{ message: { tool_calls: [{ id: '1', function: { name: 'invented', arguments: '{}' } }] } }] }) : chat(res, 'A sentence. Cut', { finish_reason: 'length' });
  const router = createConfiguredRouter({ providers: [provider()], usages: lists });
  const result = await router.route(request('hi', { tools: [{ name: 'read' }] }));
  expect(result.fallback).toBe(true); expect(result.partial).toBe(true); expect(result.value.text).toBe('A sentence.');
});

test('optional local provider works without a key and external masking remains supported', async () => {
  const p = provider(['m']); p.local = true; p.keys = [];
  expect((await createConfiguredRouter({ providers: [p] }).route('hi')).model).toBe('m');
});

test('missing credentials, invalid config, storage outage and stopped router have clean codes', async () => {
  const p = provider(['m']); p.keys = [];
  await expect(createConfiguredRouter({ providers: [p] }).route('hi')).rejects.toMatchObject({ code: 'AI_NO_PROVIDER' });
  expect(() => createConfiguredRouter({ providers: [{ ...p, format: 'other' }] })).toThrow('INVALID_PROVIDER_FORMAT');
  expect(() => createConfiguredRouter({ quotaMargin: 2 })).toThrow('INVALID_QUOTA_MARGIN');
  p.keys = ['test'];
  const router = createConfiguredRouter({ providers: [p], store: { read: async () => { throw new Error('secret'); }, update: async () => {} } });
  await expect(router.route('hi')).rejects.toThrow('AI_STATE_UNAVAILABLE');
  router.stop(); await expect(router.route('hi')).rejects.toMatchObject({ code: 'AI_ROUTER_STOPPED' });
});

test('environment prefix, sparse rotating keys, JSON usage/options and live updates', async () => {
  const env = { ARIA_PROVIDERS: JSON.stringify([{ id: 'cloud', format: 'openai', url: fixture.url, models: [{ id: 'm', rpm: 20, extra: { include_reasoning: false } }] }]), ARIA_CLOUD_KEY: 'first', ARIA_CLOUD_KEY_3: 'third', ARIA_MODELS_QUICK: JSON.stringify([{ provider: 'cloud', model: 'm' }]), ARIA_WAITED_TIMEOUT_MS: '50', ARIA_MODELS_URL: fixture.url };
  const config = readAiConfigFromEnv({ env, prefix: 'ARIA_' });
  expect(readEnvironmentKeys(env, 'ARIA_CLOUD_KEY')).toEqual(['first', 'third']);
  expect(config.waitedTimeoutMs).toBe(50); expect(config.localModels.baseUrl).toBe(fixture.url);
  const router = createConfiguredRouter(config); await router.route('hi');
  env.ARIA_CLOUD_KEY = 'replaced'; delete env.ARIA_CLOUD_KEY_3; await router.route('hi');
  expect(fixture.requests[1].headers.authorization).toBe('Bearer replaced');
  expect(() => readAiConfigFromEnv({ env: { IA_PROVIDERS: 'private-invalid-value' } })).toThrow('INVALID_AI_CONFIG_PROVIDERS');
  expect(() => readAiConfigFromEnv({ env: { IA_MODELS_CHAT: '{}' } })).toThrow('INVALID_AI_CONFIG_MODELS_CHAT');
});

test('usage-specific key pools rest independently and shared account quotas cannot be multiplied by rotation', async () => {
  const p = provider(['m']); p.keysByUsage = { news: ['news-key'], chat: ['chat-key'] };
  handle = ({ req, res }) => req.headers.authorization === 'Bearer news-key' ? json(res, {}, 429) : chat(res);
  const router = createConfiguredRouter({ providers: [p] });
  await expect(router.route('hi', { purpose: 'news' })).rejects.toBeDefined();
  expect((await router.route('hi', { purpose: 'chat' })).key).toBe('cloud:m@chat:key-1');
  handle = ({ res }) => chat(res);
  p.keysByUsage = undefined; p.keys = ['one', 'two']; p.sharedKeyQuotas = true; p.models[0].rpd = 2;
  const shared = createConfiguredRouter({ providers: [p] }); await shared.route('hi');
  await expect(shared.route('hi')).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  expect((await shared.getStats())['cloud:m'].rpdUsed).toBe(1);
});

test('all-cooling try attempts again, but daily limits and repeated failures remain enforced', async () => {
  handle = ({ res }) => json(res, {}, 429);
  const p = provider(['m']); p.models[0].rpd = 3;
  const router = createConfiguredRouter({ providers: [p], whenAllCooling: 'try' });
  await expect(router.route('hi')).rejects.toBeDefined(); handle = ({ res }) => chat(res);
  await router.route('hi'); await expect(router.route('hi')).rejects.toBeDefined();
  expect(fixture.requests).toHaveLength(2);
});

test('acceptance fallback passes through later providers in the consumer order', async () => {
  const order = [];
  handle = ({ res, body }) => { order.push(body.model); if (body.model !== 'ollama') json(res, {}, 503); else chat(res, 'local'); };
  const providers = ['groq', 'mistral', 'gemini', 'vercel', 'ollama'].map((id) => ({ id, format: 'openai', url: fixture.url, keys: ['test'], local: id === 'ollama', models: [{ id }] }));
  const router = createConfiguredRouter({ providers });
  expect((await router.route('hi')).provider).toBe('ollama'); expect(order).toEqual(['groq', 'mistral', 'gemini', 'vercel', 'ollama']);
});

test('external providers receive masked text; local providers receive clear text', async () => {
  const masker = { mask: (text) => String(text).replace('Ada', 'MASK'), maskAsync: async (value) => ({ ...value, messages: value.messages.map((m) => ({ ...m, text: m.text.replace('Ada', 'MASK') })) }), unmaskDeep: (value) => value };
  const external = createConfiguredRouter({ providers: [provider(['m'])] });
  await external.route('Ada', {}, { masker }); expect(fixture.requests[0].body.messages[0].content).toBe('MASK');
  const p = provider(['m']); p.local = true;
  await createConfiguredRouter({ providers: [p] }).route('Ada', {}, { masker }); expect(fixture.requests[1].body.messages[0].content).toBe('Ada');
});

test('waited calls time out earlier than background calls against the same slow endpoint', async () => {
  handle = ({ res }) => { setTimeout(() => chat(res, 'slow answer'), 25); };
  const router = createConfiguredRouter({ providers: [provider(['m'])], waitedTimeoutMs: 8, backgroundTimeoutMs: 100 });
  await expect(router.route('hi', { waitedOn: true })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  await router.reset();
  expect((await router.route('hi', { waitedOn: false })).value.text).toBe('slow answer');
});

test('negative token reservations and invalid deadlines cannot bypass quotas', async () => {
  const router = createConfiguredRouter({ providers: [provider(['m'])] });
  await expect(router.route('hi', { estimatedTokens: -1 })).rejects.toThrow('INVALID_ROUTING_REQUEST');
  await expect(router.route('hi', { timeoutMs: 0 })).rejects.toThrow('INVALID_ROUTING_REQUEST');
  expect(fixture.requests).toHaveLength(0);
});

test('Retry-After overrides the default rest duration', async () => {
  let time = 1000;
  handle = ({ res }) => { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2' }); res.end('{}'); };
  const router = createConfiguredRouter({ providers: [provider(['m'])], now: () => time, cooldownMs: 100 });
  await expect(router.route('hi')).rejects.toBeDefined(); expect((await router.getStats())['cloud:m@key-1'].cooldownUntil).toBe(3000);
  handle = ({ res }) => chat(res); time = 2999; await expect(router.route('hi')).rejects.toBeDefined();
  time = 3000; await router.route('hi');
});

test('local inference concurrency is bounded and queued cancellation consumes no reservation', async () => {
  let finish;
  handle = ({ res }) => { finish = () => chat(res); };
  const p = provider(['m']); p.local = true; p.maxConcurrent = 1; p.maxQueue = 1;
  const router = createConfiguredRouter({ providers: [p] });
  const first = router.route('hi');
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
  const controller = new globalThis.AbortController(); const second = router.route('hi', { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 2)); controller.abort(new Error('left'));
  await expect(second).rejects.toThrow('left');
  expect(fixture.requests).toHaveLength(1);
  finish(); await first; expect((await router.getStats())['cloud:m@key-1'].rpdUsed).toBe(1);
});
