/* global AbortController, AbortSignal */
const { EventEmitter } = require('events');
const {
  createProviderVoiceService, createPieceVoiceService, createVoiceService, createMemoryVoiceCache, createPiperProvider,
  createGeminiTtsAdapter, createWhisperHttpEngine, asVoiceProvider, runProcess, classifyProviderError
} = require('../src');

const audio = (value) => ({ audio: Buffer.from(value), format: 'wav', mimeType: 'audio/wav' });
const aborted = () => { const c = new AbortController(); c.abort(new Error('client left')); return c.signal; };

describe('cancelling the provider chain', () => {
  test('the signal reaches the provider', async () => {
    const seen = [];
    const service = createProviderVoiceService({ providers: [{ id: 'a', synthesize: async (request) => { seen.push(request.signal); return audio('a'); } }] });
    const controller = new AbortController();
    await service.synthesize({ text: 'hi', language: 'en', signal: controller.signal });
    expect(seen[0]).toBe(controller.signal);
  });

  test('already aborted: nothing is asked, not even the cache, and the error says ABORTED', async () => {
    const provider = { id: 'a', synthesize: jest.fn(async () => audio('a')) };
    const cache = { get: jest.fn(async () => null), set: jest.fn() };
    const service = createProviderVoiceService({ providers: [provider], cache });
    const error = await service.synthesize({ text: 'hi', signal: aborted() }).catch((e) => e);
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORTED' });
    expect(error.cause.message).toBe('client left');
    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  test('aborted while a provider works: no fallback, no rest for its key, nothing cached', async () => {
    const controller = new AbortController();
    const cache = createMemoryVoiceCache();
    const backup = jest.fn(async () => audio('backup'));
    const cooldowns = new Map();
    const first = {
      id: 'cloud',
      keys: ['k1', 'k2'],
      synthesize: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('network'), { status: 429 })));
      })
    };
    const service = createProviderVoiceService({
      providers: [first, { id: 'backup', synthesize: backup }],
      cache,
      cooldownStore: { getCooldown: async (id) => cooldowns.get(id), setCooldown: async (id, until) => { cooldowns.set(id, until); } }
    });
    const pending = service.synthesize({ text: 'hi', language: 'en', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(backup).not.toHaveBeenCalled();
    expect(cooldowns.size).toBe(0);
    expect(cache.size).toBe(0);
  });

  test('without a signal nothing changes: a failing provider still falls through to the next', async () => {
    const service = createProviderVoiceService({ providers: [
      { id: 'a', synthesize: async () => { throw new Error('boom'); } },
      { id: 'b', synthesize: async () => audio('b') }
    ] });
    expect((await service.synthesize({ text: 'hi' })).provider).toBe('b');
  });

  test('ABORTED is its own class of error', () => {
    expect(classifyProviderError({ name: 'AbortError', code: 'ABORTED' })).toBe('ABORTED');
    expect(classifyProviderError({ name: 'AbortError' })).toBe('TRANSIENT');
  });

  test('the Piper provider of the command-line service forwards it', async () => {
    const service = { synthesize: jest.fn(async () => audio('p')) };
    const controller = new AbortController();
    await createPiperProvider(service).synthesize({ text: 'hi', language: 'en', signal: controller.signal });
    expect(service.synthesize).toHaveBeenCalledWith({ text: 'hi', language: 'en', signal: controller.signal });
  });

  test('Gemini: the request is cancelled by the caller\'s signal as well as by its timeout', async () => {
    const signals = [];
    const fetch = async (_url, init) => {
      signals.push(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const adapter = createGeminiTtsAdapter({ fetch, endpoint: (m) => `https://example.invalid/${m}`, model: 'm', voice: 'v', keys: ['k'], timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = adapter.synthesize({ text: 'hi', key: 'k', language: 'en', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(signals[0].aborted).toBe(true);
    // without a signal the timeout alone is still there
    const lone = createGeminiTtsAdapter({ fetch: async (_u, init) => { signals.push(init.signal); return { ok: false, status: 500 }; }, endpoint: () => 'x', model: 'm', voice: 'v', keys: ['k'] });
    await lone.synthesize({ text: 'hi', key: 'k', language: 'en' }).catch(() => {});
    expect(signals[1]).toBeInstanceOf(AbortSignal);
  });

  test('the whisper-http engine and asVoiceProvider forward it', async () => {
    const seen = [];
    const fetch = async (_url, init) => {
      seen.push(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled'))));
    };
    const engine = createWhisperHttpEngine({ ttsModel: 'tts', fetch });
    const provider = asVoiceProvider(engine, { defaultVoice: 'v' });
    const controller = new AbortController();
    const pending = provider.synthesize({ text: 'hi', language: 'fr', signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(seen[0].aborted).toBe(true);
  });
});

describe('cancelling the command-line pipeline', () => {
  function fakeSpawn({ closeOn = 'never' } = {}) {
    const children = [];
    const spawn = (command) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() { if (closeOn === 'immediate') process.nextTick(() => child.emit('close', 0)); } };
      child.kill = jest.fn();
      child.command = command;
      children.push(child);
      return child;
    };
    return { spawn, children };
  }
  const clock = { now: () => 1, setTimeout, clearTimeout };

  test('runProcess kills the process and rejects as aborted', async () => {
    const { spawn, children } = fakeSpawn();
    const controller = new AbortController();
    const running = runProcess(spawn, 'piper', [], { clock, timeoutMs: 60000, signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError', code: 'ABORTED' });
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    // a late close changes nothing
    children[0].emit('close', 0);
  });

  test('runProcess with an aborted signal does not even spawn', async () => {
    const { spawn, children } = fakeSpawn();
    await expect(runProcess(spawn, 'piper', [], { clock, timeoutMs: 1000, signal: aborted() })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(children).toHaveLength(0);
  });

  test('a finished process forgets the signal', async () => {
    const { spawn } = fakeSpawn({ closeOn: 'immediate' });
    const controller = new AbortController();
    await runProcess(spawn, 'piper', [], { clock, timeoutMs: 1000, signal: controller.signal });
    controller.abort();
  });

  test('createVoiceService: aborted while piper runs, piper is killed, files cleaned, no cache write, error is the abort itself', async () => {
    const { spawn, children } = fakeSpawn();
    const removed = [];
    const cache = createMemoryVoiceCache();
    const service = createVoiceService({
      spawn,
      filesystem: { readFile: async () => Buffer.from('x'), rename: async () => {}, remove: async (name) => { removed.push(name); } },
      cache,
      models: { en: '/m.onnx' },
      defaultLanguage: 'en',
      temporaryDirectory: '/w',
      clock
    });
    const controller = new AbortController();
    const pending = service.synthesize({ text: 'Hello', language: 'en', signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const error = await pending.catch((e) => e);
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORTED' });
    expect(children[0].kill).toHaveBeenCalled();
    expect(removed.length).toBe(3);
    expect(cache.size).toBe(0);
    await expect(service.synthesize({ text: 'Hello', signal: aborted() })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(children).toHaveLength(1);
  });
});

describe('cancelling readings in pieces', () => {
  test('no other provider takes over, no new piece starts', async () => {
    const controller = new AbortController();
    const calls = [];
    const providers = [
      { id: 'a', synthesize: async ({ text }) => { calls.push(text); controller.abort(); return text; } },
      { id: 'b', synthesize: jest.fn(async ({ text }) => text) }
    ];
    const service = createPieceVoiceService({ providers, maxConcurrent: 1 });
    await expect(service.synthesize(['one', 'two', 'three'], { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(calls).toEqual(['one']);
    expect(providers[1].synthesize).not.toHaveBeenCalled();
    await expect(service.synthesize(['one'], { signal: aborted() })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
