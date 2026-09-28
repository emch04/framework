const {
  createProviderVoiceService, createGeminiTtsAdapter, createMemoryVoiceCache,
  createVadSegmenter, createEchoGuard, appendTrailingSilence,
  isDoubtfulTranscription, createLocalTranscriber, createConfidentialPolicy
} = require('../src');

const audio = (word) => ({ audio: Buffer.from(word), format: 'wav', mimeType: 'audio/wav' });

test('rotates after quota, cools only the failed key, then uses fallback', async () => {
  let now = 0;
  const tried = [];
  const primary = { id: 'primary', keys: ['fake-' + 'one', 'fake-' + 'two'], synthesize: async ({ key }) => {
    tried.push(key);
    if (key.endsWith('one')) throw Object.assign(new Error('quota'), { status: 429 });
    return audio('primary');
  } };
  const fallback = { id: 'fallback', synthesize: async () => audio('fallback') };
  const service = createProviderVoiceService({ providers: [primary, fallback], clock: { now: () => now }, cooldownMs: 100 });
  expect((await service.synthesize({ text: 'first' })).provider).toBe('primary');
  primary.keys = ['fake-' + 'two', 'fake-' + 'one'];
  await service.synthesize({ text: 'second' });
  await service.synthesize({ text: 'second again' });
  expect(tried.filter((key) => key.endsWith('one'))).toHaveLength(1);
  primary.synthesize = async () => { throw new Error('offline'); };
  expect((await service.synthesize({ text: 'third' })).provider).toBe('fallback');
  now = 101;
  expect((await service.synthesize({ text: 'fourth' })).provider).toBe('fallback');
});

test('cache key includes caller voice version and cache outages do not suppress speech', async () => {
  const cache = createMemoryVoiceCache();
  const call = jest.fn(async () => audio('sound'));
  const service = createProviderVoiceService({ providers: [{ synthesize: call }], cache });
  const first = await service.synthesize({ text: 'hello', voiceVersion: 'a' });
  expect((await service.synthesize({ text: 'hello', voiceVersion: 'a' })).cached).toBe(true);
  const next = await service.synthesize({ text: 'hello', voiceVersion: 'b' });
  expect(next.cacheKey).not.toBe(first.cacheKey);
  expect(call).toHaveBeenCalledTimes(2);
  const broken = createProviderVoiceService({ providers: [{ synthesize: call }], cache: { get: () => { throw new Error(); }, set: () => { throw new Error(); } } });
  await expect(broken.synthesize({ text: 'hello' })).resolves.toMatchObject({ cached: false });
});

test('missing provider dependency falls through to the next provider', async () => {
  const service = createProviderVoiceService({ providers: [
    { keys: () => { throw new Error('storage offline'); }, synthesize: jest.fn() },
    { id: 'local', synthesize: async () => audio('local') }
  ] });
  expect((await service.synthesize({ text: 'hello' })).provider).toBe('local');
});

test('Gemini adapter sends key in header and wraps returned PCM as WAV', async () => {
  const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: {
    mimeType: 'audio/L16;rate=24000', data: Buffer.from([1, 2]).toString('base64')
  } }] } }] }) }));
  const adapter = createGeminiTtsAdapter({ fetch, endpoint: (model) => `https://example.invalid/${model}`, model: 'fake-model', voice: 'fake-voice' });
  const result = await adapter.synthesize({ text: 'hello', key: 'fake-' + 'key' });
  expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF');
  expect(result.audio.readUInt32LE(24)).toBe(24000);
  expect(fetch.mock.calls[0][0]).not.toContain('fake-key');
  expect(fetch.mock.calls[0][1].headers['x-goog-api-key']).toBe('fake-key');
});

test('VAD emits speech after silence and falls back to energy when classifier fails', async () => {
  const fail = jest.fn();
  const segmenter = createVadSegmenter({ classify: () => { throw new Error('model unavailable'); }, onClassifierFailure: fail,
    startFrames: 2, endFrames: 2, lookbackFrames: 1 });
  const sound = new Float32Array([0.3, 0.3]);
  await segmenter.push(new Float32Array(2));
  await segmenter.push(sound); await segmenter.push(sound);
  await segmenter.push(new Float32Array(2));
  const segments = await segmenter.push(new Float32Array(2));
  expect(fail).toHaveBeenCalledTimes(1);
  expect(segments).toHaveLength(1);
  expect(segments[0]).toEqual(new Float32Array([0, 0, 0.3, 0.3, 0.3, 0.3, 0, 0, 0, 0]));
});

test('echo guard drops matching playback and passes audio on comparator failure', async () => {
  const frame = new Float32Array([0.4]);
  const guard = createEchoGuard({ compare: async () => 0.9 });
  expect(await guard.filter(frame)).toBe(frame);
  guard.setPlaying(true);
  expect(await guard.filter(frame)).toBeNull();
  const broken = createEchoGuard({ compare: () => { throw new Error(); } });
  broken.setPlaying(true);
  expect(await broken.filter(frame)).toBe(frame);
});

test('local transcription pads 500 ms and flags injected stock phrases, loops and sparse speech', async () => {
  const decode = jest.fn(async () => ({ text: 'known invented phrase', confidence: 0.95 }));
  const local = createLocalTranscriber({ transcribe: decode, sampleRate: 1000, doubtfulOptions: { stockPhrases: ['invented phrase'] } });
  const result = await local.transcribe(new Float32Array(1000).fill(0.5));
  expect(decode.mock.calls[0][0]).toHaveLength(1500);
  expect(decode.mock.calls[0][0][1499]).toBe(0);
  expect(result).toMatchObject({ doubtful: true, confidence: 0.1, durationMs: 1000 });
  expect(isDoubtfulTranscription('word word word word', 1000)).toBe(true);
  expect(isDoubtfulTranscription('one two', 6000)).toBe(true);
  expect(isDoubtfulTranscription('brrr zzzz hmmm', 1000)).toBe(true);
  expect(isDoubtfulTranscription('a clear useful sentence', 2000)).toBe(false);
  expect(appendTrailingSilence(new Float32Array(2), 1000)).toHaveLength(502);
});

test('confidential session never sends audio to cloud unless role and session allow fallback', () => {
  const policy = createConfidentialPolicy({ defaultRoles: ['restricted'], cloudFallbackRoles: ['adult'] });
  expect(policy.decide({ role: 'restricted' }).cloudAudioAllowed).toBe(false);
  expect(policy.onLocalFailure({ role: 'restricted', allowCloudFallback: true }).reason).toBe('LOCAL_FAILURE_CLOUD_DENIED');
  expect(policy.onLocalFailure({ role: 'adult', requestedMode: 'confidential', allowCloudFallback: true }))
    .toEqual({ mode: 'normal', cloudAudioAllowed: true, reason: 'LOCAL_FAILURE_FALLBACK' });
  expect(policy.decide({ role: 'adult' }).cloudAudioAllowed).toBe(true);
});
