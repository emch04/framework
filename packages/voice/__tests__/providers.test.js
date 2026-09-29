const { createProviderVoiceService, createGeminiTtsAdapter, classifyProviderError, createMemoryVoiceCache } = require('../src');
const audio = (value) => ({ audio: Buffer.from(value), format: 'wav', mimeType: 'audio/wav' });
const quota = () => Object.assign(new Error('quota'), { status: 429 });

test('cache identity separates providers even for the same text', async () => {
  const cache = createMemoryVoiceCache();
  const first = createProviderVoiceService({ providers: [{ id: 'a', synthesize: async () => audio('a') }], cache });
  const second = createProviderVoiceService({ providers: [{ id: 'b', synthesize: async () => audio('b') }], cache });
  expect((await first.synthesize({ text: 'hello' })).audio.toString()).toBe('a');
  expect((await second.synthesize({ text: 'hello' })).audio.toString()).toBe('b');
  expect(cache.size).toBe(2);
});
test('cache identity separates voice choices', async () => {
  const cache = createMemoryVoiceCache();
  const service = createProviderVoiceService({ providers: [{ id: 'a', synthesize: async ({ voice }) => audio(voice) }], cache });
  expect((await service.synthesize({ text: 'hello', voice: 'one' })).cacheKey)
    .not.toBe((await service.synthesize({ text: 'hello', voice: 'two' })).cacheKey);
});
test('fallback cache does not shadow restored primary', async () => {
  const cache = createMemoryVoiceCache(); let available = false;
  const service = createProviderVoiceService({ providers: [
    { id: 'primary', synthesize: async () => { if (!available) throw new Error(); return audio('primary'); } },
    { id: 'backup', synthesize: async () => audio('backup') }
  ], cache });
  expect((await service.synthesize({ text: 'hello' })).provider).toBe('backup');
  available = true;
  expect((await service.synthesize({ text: 'hello' })).provider).toBe('primary');
});
test('cached primary identifies provider and does not call synthesis', async () => {
  const cache = createMemoryVoiceCache(); let count = 0;
  const service = createProviderVoiceService({ providers: [{ id: 'primary', synthesize: async () => { count++; return audio('ok'); } }], cache });
  await service.synthesize({ text: 'hello' });
  expect(await service.synthesize({ text: 'hello' })).toMatchObject({ provider: 'primary', cached: true });
  expect(count).toBe(1);
});
test('key cooldown survives a new service through the injected store', async () => {
  const records = new Map(); let calls = 0;
  const cooldownStore = { getCooldown: async (id) => records.get(id), setCooldown: async (id, until) => { records.set(id, until); } };
  const provider = { id: 'cloud', keys: ['fake-' + 'key'], synthesize: async () => { calls++; throw quota(); } };
  const options = { providers: [provider, { id: 'local', synthesize: async () => audio('local') }], cooldownStore, clock: { now: () => 0 } };
  await createProviderVoiceService(options).synthesize({ text: 'one' });
  await createProviderVoiceService(options).synthesize({ text: 'two' });
  expect(calls).toBe(1);
  expect([...records.keys()][0]).not.toContain('fake-key');
});
test('daily success limit skips a key and tries another', async () => {
  const counts = new Map();
  const usageStore = { getCount: async (id) => counts.get(id) || 0, increment: async (id) => { counts.set(id, (counts.get(id) || 0) + 1); } };
  const keys = ['fake-' + 'a', 'fake-' + 'b'];
  const seen = [];
  const service = createProviderVoiceService({ providers: [
    { id: 'cloud', keys, synthesize: async ({ key }) => { seen.push(key); return audio(key); } },
    { id: 'local', synthesize: async () => audio('local') }
  ], usageStore, maxSuccessesPerDay: 1, clock: { now: () => 0 } });
  await service.synthesize({ text: 'one' }); await service.synthesize({ text: 'two' });
  expect((await service.synthesize({ text: 'three' })).provider).toBe('local');
  expect(seen).toEqual(['fake-a', 'fake-b']);
});
test('fallback can be pinned to a caller scope for consistent voice', async () => {
  const scopes = new Map();
  const fallbackStore = { get: async (scope) => scopes.get(scope), set: async (scope, id) => { scopes.set(scope, id); } };
  let available = false;
  const service = createProviderVoiceService({ providers: [
    { id: 'cloud', synthesize: async () => { if (!available) throw new Error(); return audio('cloud'); } },
    { id: 'local', synthesize: async () => audio('local') }
  ], fallbackStore });
  expect((await service.synthesize({ text: 'one', fallbackScope: 'session-1' })).provider).toBe('local');
  available = true;
  expect((await service.synthesize({ text: 'two', fallbackScope: 'session-1' })).provider).toBe('local');
});
test('key order is stable and a quota advances to the next key', async () => {
  const tried = [];
  const service = createProviderVoiceService({ providers: [{ id: 'cloud', keys: ['fake-' + 'a', 'fake-' + 'b'], synthesize: async ({ key }) => {
    tried.push(key); if (key.endsWith('a')) throw quota(); return audio('ok');
  } }] });
  await service.synthesize({ text: 'hello' });
  expect(tried).toEqual(['fake-a', 'fake-b']);
});
test('models are attempted in declared order before fallback', async () => {
  const tried = [];
  const service = createProviderVoiceService({ providers: [{ id: 'cloud', models: ['one', 'two'], keys: ['fake-' + 'a'], synthesize: async ({ model }) => {
    tried.push(model); if (model === 'one') throw quota(); return audio('ok');
  } }] });
  expect((await service.synthesize({ text: 'hello' })).provider).toBe('cloud');
  expect(tried).toEqual(['one', 'two']);
});
test('result reports failed attempts and fallback provider', async () => {
  const service = createProviderVoiceService({ providers: [
    { id: 'cloud', synthesize: async () => { throw quota(); } },
    { id: 'local', synthesize: async () => audio('ok') }
  ] });
  expect(await service.synthesize({ text: 'hello' })).toMatchObject({ provider: 'local', fallback: true, attempts: [{ provider: 'cloud', code: 'QUOTA' }] });
});
test.each([[429, 'QUOTA'], [401, 'AUTH'], [403, 'AUTH'], [500, 'TRANSIENT']])('HTTP %i classifies as %s', (status, code) => {
  expect(classifyProviderError({ status })).toBe(code);
});
test('an aborted provider request is transient', () => {
  expect(classifyProviderError({ name: 'AbortError' })).toBe('TRANSIENT');
});
test('caller can rest an auth-failed key for a configured duration', async () => {
  let now = 0; let calls = 0;
  const service = createProviderVoiceService({ providers: [
    { id: 'cloud', keys: ['fake-' + 'key'], synthesize: async () => { calls++; throw Object.assign(new Error(), { status: 401 }); } },
    { id: 'local', synthesize: async () => audio('local') }
  ], clock: { now: () => now }, cooldownMsByCode: { AUTH: 100 } });
  await service.synthesize({ text: 'one' }); await service.synthesize({ text: 'two' });
  expect(calls).toBe(1);
  now = 101; await service.synthesize({ text: 'three' });
  expect(calls).toBe(2);
});
test('daily key quota does not limit an unkeyed local fallback', async () => {
  const usageStore = { getCount: async () => 100, increment: async () => undefined };
  const service = createProviderVoiceService({ providers: [{ id: 'local', synthesize: async () => audio('local') }], usageStore });
  expect((await service.synthesize({ text: 'hello' })).provider).toBe('local');
});
test('cached fallback pins a new caller scope', async () => {
  const scopes = new Map(); let available = false;
  const fallbackStore = { get: async (scope) => scopes.get(scope), set: async (scope, id) => { scopes.set(scope, id); } };
  const service = createProviderVoiceService({ providers: [
    { id: 'cloud', synthesize: async () => { if (!available) throw new Error(); return audio('cloud'); } },
    { id: 'local', synthesize: async () => audio('local') }
  ], fallbackStore, cache: createMemoryVoiceCache() });
  await service.synthesize({ text: 'same' });
  expect((await service.synthesize({ text: 'same', fallbackScope: 'session' })).provider).toBe('local');
  available = true;
  expect((await service.synthesize({ text: 'next', fallbackScope: 'session' })).provider).toBe('local');
});
test('stale pinned provider degrades to the configured chain', async () => {
  const service = createProviderVoiceService({ providers: [{ id: 'local', synthesize: async () => audio('local') }], fallbackStore: { get: async () => 'removed-provider' } });
  expect((await service.synthesize({ text: 'hello', fallbackScope: 'session' })).provider).toBe('local');
});
test('Gemini request uses source wire names and selects voice by language', async () => {
  let request;
  const adapter = createGeminiTtsAdapter({ fetch: async (_url, init) => { request = init; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=8000', data: Buffer.from([1, 2]).toString('base64') } }] } }] }) }; }, endpoint: () => 'https://example.invalid', model: 'fake-model', voices: { en: 'voice-en', fr: 'voice-fr' } });
  const result = await adapter.synthesize({ text: 'hello', language: 'en', key: 'fake-' + 'key' });
  expect(JSON.parse(request.body).generationConfig.speech_config.voice_config.prebuilt_voice_config.voice_name).toBe('voice-en');
  expect(result.audio.readUInt32LE(24)).toBe(8000);
});
test('Gemini malformed PCM is rejected with a code', async () => {
  const adapter = createGeminiTtsAdapter({ fetch: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=8000', data: Buffer.from([1]).toString('base64') } }] } }] }) }), endpoint: () => 'https://example.invalid', model: 'fake-model', voice: 'fake-voice' });
  await expect(adapter.synthesize({ text: 'hello', key: 'fake-' + 'key' })).rejects.toMatchObject({ code: 'INVALID_AUDIO' });
});
test('Gemini adapter accepts an already encoded WAV', async () => {
  const wav = Buffer.from('RIFF' + 'data');
  const adapter = createGeminiTtsAdapter({ fetch: async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] } }] }) }), endpoint: () => 'https://example.invalid', model: 'fake-model', voice: 'fake-voice' });
  expect((await adapter.synthesize({ text: 'hello', key: 'fake-' + 'key' })).audio).toEqual(wav);
});
test('Gemini adapter can use the alternate request field style', async () => {
  let body;
  const adapter = createGeminiTtsAdapter({ wireStyle: 'camel', fetch: async (_url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=8000', data: Buffer.from([1, 2]).toString('base64') } }] } }] }) }; }, endpoint: () => 'https://example.invalid', model: 'fake-model', voice: 'fake-voice' });
  await adapter.synthesize({ text: 'hello', key: 'fake-' + 'key' });
  expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('fake-voice');
});
test('all providers unavailable returns codes without exposing keys', async () => {
  const service = createProviderVoiceService({ providers: [{ id: 'cloud', keys: ['fake-' + 'key'], synthesize: async () => { throw quota(); } }] });
  try { await service.synthesize({ text: 'hello' }); throw new Error('expected failure'); }
  catch (error) { expect(error.code).toBe('PROVIDERS_UNAVAILABLE'); expect(JSON.stringify(error.attempts)).not.toContain('fake-key'); }
});

describe('reading in the cloud, key by key', () => {
  const resting = (calls) => async () => { calls.push('called'); throw Object.assign(new Error('bad'), { status: 400 }); };

  test('a key that gave out is left out while it rests, unless the service tries the resting ones last', async () => {
    let now = 0; const seen = [];
    const build = (extra) => createProviderVoiceService({
      providers: [{ id: 'cloud', keys: ['one', 'two'], models: ['m'], synthesize: async ({ key }) => { seen.push(key); if (key === 'one') throw Object.assign(new Error('x'), { status: 400 }); return audio(key); } }],
      clock: { now: () => now }, cooldownMsByCode: { PROVIDER_ERROR: 600000 }, ...extra
    });
    const plain = build({});
    expect((await plain.synthesize({ text: 'a' })).audio.toString()).toBe('two');
    seen.length = 0;
    now = 1000;
    await plain.synthesize({ text: 'b' });
    expect(seen).toEqual(['two']);
    /* Everything rests: nothing is asked without the option; with it, the resting ones are still tried. */
    const failing = { id: 'cloud', keys: ['one'], synthesize: async () => { throw quota(); } };
    const strict = createProviderVoiceService({ providers: [failing], clock: { now: () => now } });
    await expect(strict.synthesize({ text: 'c' })).rejects.toMatchObject({ code: 'PROVIDERS_UNAVAILABLE' });
    let calls = 0;
    const counted = { id: 'cloud', keys: ['one'], synthesize: async () => { calls++; throw quota(); } };
    const lenient = createProviderVoiceService({ providers: [counted], clock: { now: () => now }, restingLast: true });
    await expect(lenient.synthesize({ text: 'd' })).rejects.toMatchObject({ code: 'PROVIDERS_UNAVAILABLE' });
    await expect(lenient.synthesize({ text: 'e' })).rejects.toMatchObject({ code: 'PROVIDERS_UNAVAILABLE' });
    expect(calls).toBe(2);
  });
  test('with restingLast every model on every key is tried, those at rest after the others', async () => {
    const seen = [];
    const service = createProviderVoiceService({
      providers: [{ id: 'cloud', keys: ['a', 'b'], models: ['best', 'older'], synthesize: async ({ key, model }) => { seen.push(`${model}|${key}`); throw quota(); } }],
      clock: { now: () => 0 }, restingLast: true
    });
    await expect(service.synthesize({ text: 'x' })).rejects.toMatchObject({ attempts: expect.any(Array) });
    expect(seen).toEqual(['best|a', 'best|b', 'older|a', 'older|b']);
    seen.length = 0;
    await expect(service.synthesize({ text: 'y' })).rejects.toBeTruthy();
    /* Every pair rests now: they are all tried once more, in order, none is skipped. */
    expect(seen.sort()).toEqual(['best|a', 'best|b', 'older|a', 'older|b']);
  });
  test('a rest can be set for any kind of failure', async () => {
    let now = 0; const calls = [];
    const service = createProviderVoiceService({
      providers: [{ id: 'cloud', keys: ['one'], synthesize: resting(calls) }, { id: 'local', synthesize: async () => audio('local') }],
      clock: { now: () => now }, cooldownMsByCode: { PROVIDER_ERROR: 60000 }
    });
    await service.synthesize({ text: 'a' }); await service.synthesize({ text: 'b' });
    expect(calls).toHaveLength(1);
    now = 60001;
    await service.synthesize({ text: 'c' });
    expect(calls).toHaveLength(2);
  });
  test('Gemini answers in a WAV file whatever its mime type says, or in raw PCM at the rate it names', async () => {
    const { pcm16ToWav } = require('../src');
    const pcm = Buffer.alloc(480, 1);
    const answer = (mimeType, data) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data: data.toString('base64') } }] } }] }) });
    const wav = pcm16ToWav(pcm, 24000);
    const adapter = (fetch) => createGeminiTtsAdapter({ fetch, endpoint: () => 'https://example.invalid', model: 'm', voice: 'v', keys: ['k'] });
    expect((await adapter(async () => answer('audio/unknown', wav)).synthesize({ text: 'a', key: 'k' })).audio.equals(wav)).toBe(true);
    const raw = await adapter(async () => answer('audio/l16; rate=16000', pcm)).synthesize({ text: 'a', key: 'k' });
    expect(raw.audio.readUInt32LE(24)).toBe(16000);
    expect(raw.audio.subarray(0, 4).toString()).toBe('RIFF');
    expect((await adapter(async () => answer('audio/pcm', pcm)).synthesize({ text: 'a', key: 'k' })).audio.readUInt32LE(24)).toBe(24000);
    await expect(adapter(async () => answer('audio/mpeg', pcm)).synthesize({ text: 'a', key: 'k' })).rejects.toMatchObject({ code: 'INVALID_AUDIO' });
  });
});
