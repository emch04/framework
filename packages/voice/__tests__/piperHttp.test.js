/* global AbortController */
const { createPiperHttpProvider, createProviderVoiceService, createMemoryVoiceCache } = require('../src');

function reply(body, { status = 200, type = 'audio/wav' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => Uint8Array.from(Buffer.from(body)).buffer
  };
}

function build(options = {}, answer = () => reply('WAV')) {
  const calls = [];
  const fetch = jest.fn(async (url, init) => { calls.push({ url, init }); return answer(url, init); });
  const provider = createPiperHttpProvider({ url: 'http://127.0.0.1:5000/', fetch, ...options });
  return { provider, fetch, calls };
}

describe('Piper over HTTP', () => {
  test('posts text and language as JSON to /tts and returns the audio', async () => {
    const { provider, calls } = build();
    const out = await provider.synthesize({ text: 'Bonjour', language: 'fr' });
    expect(calls[0].url).toBe('http://127.0.0.1:5000/tts');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ text: 'Bonjour', lang: 'fr' });
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(out).toMatchObject({ format: 'wav', mimeType: 'audio/wav' });
    expect(Buffer.isBuffer(out.audio)).toBe(true);
    expect(out.audio.toString()).toBe('WAV');
    expect(provider.id).toBe('piper-http');
  });

  test('the token comes from an option, a function, or a file read at every request', async () => {
    const fixed = build({ token: 'jeton-un' });
    await fixed.provider.synthesize({ text: 'a', language: 'fr' });
    expect(fixed.calls[0].init.headers.Authorization).toBe('Bearer jeton-un');

    const dynamic = build({ token: async () => ' jeton-deux\n' });
    await dynamic.provider.synthesize({ text: 'a', language: 'fr' });
    expect(dynamic.calls[0].init.headers.Authorization).toBe('Bearer jeton-deux');

    let content = 'avant\n';
    const readFile = jest.fn(async () => content);
    const filed = build({ tokenFile: '/run/secrets/piper', readFile });
    await filed.provider.synthesize({ text: 'a', language: 'fr' });
    content = 'apres\n';
    await filed.provider.synthesize({ text: 'b', language: 'fr' });
    expect(filed.calls.map((call) => call.init.headers.Authorization)).toEqual(['Bearer avant', 'Bearer apres']);
    expect(readFile).toHaveBeenCalledWith('/run/secrets/piper', 'utf8');
  });

  test('an unreadable token file is an authentication failure that names no path', async () => {
    const { provider, fetch } = build({ tokenFile: '/secret/path', readFile: async () => { throw new Error('ENOENT /secret/path'); } });
    const error = await provider.synthesize({ text: 'a', language: 'fr' }).catch((e) => e);
    expect(error.code).toBe('AUTH');
    expect(error.message).not.toContain('/secret/path');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('the default language replaces "auto"; a voice and extra headers are forwarded; the body can be rebuilt', async () => {
    const { provider, calls } = build({ defaultLanguage: 'fr', headers: { 'X-App': 'x' } });
    await provider.synthesize({ text: 'a', language: 'auto', voice: 'siwis' });
    expect(JSON.parse(calls[0].init.body)).toEqual({ text: 'a', lang: 'fr', voice: 'siwis' });
    expect(calls[0].init.headers['X-App']).toBe('x');

    const custom = build({ path: '/speak', buildBody: ({ text, language }) => ({ input: text, language }) });
    await custom.provider.synthesize({ text: 'a', language: 'en' });
    expect(custom.calls[0].url).toBe('http://127.0.0.1:5000/speak');
    expect(JSON.parse(custom.calls[0].init.body)).toEqual({ input: 'a', language: 'en' });
  });

  test('the format follows the content type of the answer', async () => {
    const { provider } = build({}, () => reply('M4A', { type: 'audio/mp4' }));
    expect(await provider.synthesize({ text: 'a', language: 'fr' })).toMatchObject({ format: 'm4a', mimeType: 'audio/mp4' });
    const unknown = build({}, () => reply('X', { type: 'application/octet-stream' }));
    expect(await unknown.provider.synthesize({ text: 'a', language: 'fr' })).toMatchObject({ format: 'wav', mimeType: 'audio/wav' });
  });

  test('HTTP errors carry the status, so the provider chain classifies them', async () => {
    const quota = build({}, () => reply('', { status: 429 }));
    const error = await quota.provider.synthesize({ text: 'a', language: 'fr' }).catch((e) => e);
    expect(error).toMatchObject({ status: 429, code: 'QUOTA' });
    const denied = build({}, () => reply('', { status: 401 }));
    expect(await denied.provider.synthesize({ text: 'a', language: 'fr' }).catch((e) => e)).toMatchObject({ status: 401, code: 'AUTH' });
  });

  test('a timeout is a transient failure; a cancellation is an abort, not a failure of the service', async () => {
    const hang = (_url, init) => new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('x'), { name: init.signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError' }));
      if (init.signal.aborted) fail();
      else init.signal.addEventListener('abort', fail);
    });
    const slow = build({ timeoutMs: 20 }, hang);
    expect(await slow.provider.synthesize({ text: 'a', language: 'fr' }).catch((e) => e)).toMatchObject({ message: 'PIPER_TIMEOUT', code: 'TRANSIENT' });

    const controller = new AbortController();
    const cancelled = build({ timeoutMs: 5000 }, hang);
    const pending = cancelled.provider.synthesize({ text: 'a', language: 'fr', signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await pending.catch((e) => e)).toMatchObject({ name: 'AbortError', code: 'ABORTED' });
  });

  test('an already aborted signal sends nothing', async () => {
    const { provider, fetch } = build();
    const controller = new AbortController();
    controller.abort();
    await expect(provider.synthesize({ text: 'a', language: 'fr', signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('options are checked', () => {
    expect(() => createPiperHttpProvider({})).toThrow(/url/);
    expect(() => createPiperHttpProvider({ url: 'ftp://x', fetch: () => {} })).toThrow(/http/);
    expect(() => createPiperHttpProvider({ url: 'not a url', fetch: () => {} })).toThrow(/http/);
    expect(() => createPiperHttpProvider({ url: 'http://x', fetch: () => {}, token: 'a', tokenFile: 'b' })).toThrow(/not both/);
  });

  test('in a chain: first provider down, Piper HTTP takes over and the phrase is cached', async () => {
    const { provider, fetch } = build({ token: 't' });
    const cache = createMemoryVoiceCache();
    const service = createProviderVoiceService({
      providers: [{ id: 'cloud', synthesize: async () => { throw Object.assign(new Error('down'), { status: 503 }); } }, provider],
      cache
    });
    const first = await service.synthesize({ text: 'Bonjour', language: 'fr' });
    expect(first).toMatchObject({ provider: 'piper-http', fallback: true, cached: false });
    expect(first.attempts).toEqual([{ provider: 'cloud', model: null, code: 'TRANSIENT' }]);
    const second = await service.synthesize({ text: 'Bonjour', language: 'fr' });
    expect(second).toMatchObject({ provider: 'piper-http', cached: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('a 5xx answer rests nothing by default and an empty body is an invalid audio', async () => {
    const { provider } = build({}, () => reply(''));
    const service = createProviderVoiceService({ providers: [provider] });
    await expect(service.synthesize({ text: 'a', language: 'fr' })).rejects.toMatchObject({ code: 'PROVIDERS_UNAVAILABLE', attempts: [{ provider: 'piper-http', code: 'INVALID_AUDIO' }] });
  });
});
