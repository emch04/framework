const { EventEmitter } = require('events');
const { createMemoryVoiceCache, createVoiceService } = require('../src');

function createFilesystem() {
  const files = new Map();
  return {
    files,
    async readFile(name) {
      if (!files.has(name)) throw new Error(`missing ${name}`);
      return Buffer.from(files.get(name));
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`missing ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async remove(name) {
      files.delete(name);
    }
  };
}

function createSpawn(filesystem, options = {}) {
  const calls = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = {
      write(value) { input += value; },
      end() {
        process.nextTick(() => {
          calls.push({ command, args, input });
          if (command === 'piper') {
            filesystem.files.set(args[args.indexOf('--output_file') + 1], Buffer.from(`wav:${input}`));
            child.emit('close', options.piperCode ?? 0);
            return;
          }
          if (options.ffmpegError) {
            filesystem.files.set(args.at(-1), Buffer.from('truncated'));
            child.stderr.emit('data', 'encoder unavailable');
            child.emit('close', 1);
            return;
          }
          filesystem.files.set(args.at(-1), Buffer.from(`m4a:${input}`));
          child.emit('close', 0);
        });
      }
    };
    child.kill = jest.fn();
    return child;
  };
  return { calls, spawn };
}

function build(options = {}) {
  const filesystem = createFilesystem();
  const processRunner = createSpawn(filesystem, options);
  const cache = options.cache || createMemoryVoiceCache();
  const service = createVoiceService({
    spawn: processRunner.spawn,
    filesystem,
    cache,
    models: { en: '/voices/en.onnx', es: '/voices/es.onnx' },
    defaultLanguage: 'en',
    speakers: { es: 1 },
    temporaryDirectory: '/voice-work',
    clock: { now: () => 1234, setTimeout, clearTimeout }
  });
  return { cache, filesystem, processRunner, service };
}

describe('synthesize and finish', () => {
  test('pipes text to Piper, atomically finishes AAC, caches it and removes work files', async () => {
    const { cache, filesystem, processRunner, service } = build();
    const result = await service.synthesize({ text: '  Hello world  ', language: 'en-US' });

    expect(result).toMatchObject({ format: 'm4a', mimeType: 'audio/mp4', cached: false });
    expect(result.audio.toString()).toBe('m4a:');
    expect(processRunner.calls.map((call) => call.command)).toEqual(['piper', 'ffmpeg']);
    expect(processRunner.calls[0].input).toBe('Hello world');
    expect(processRunner.calls[1].args.at(-1)).toMatch(/\.part\.m4a$/);
    expect(cache.size).toBe(1);
    expect(filesystem.files.size).toBe(0);
  });

  test('a cache hit runs neither Piper nor ffmpeg and returns a defensive copy', async () => {
    const { processRunner, service } = build();
    const first = await service.synthesize({ text: 'Hello', language: 'en' });
    first.audio[0] = 0;
    const second = await service.synthesize({ text: 'Hello', language: 'en' });

    expect(second.cached).toBe(true);
    expect(second.audio.toString()).toBe('m4a:');
    expect(processRunner.calls).toHaveLength(2);
  });

  test('a new voice version misses old cached audio', async () => {
    const cache = createMemoryVoiceCache();
    const old = build({ cache });
    await old.service.synthesize({ text: 'Hello', language: 'en' });
    const filesystem = createFilesystem();
    const processRunner = createSpawn(filesystem);
    const next = createVoiceService({
      spawn: processRunner.spawn,
      filesystem,
      cache,
      models: { en: '/voices/en.onnx' },
      defaultLanguage: 'en',
      voiceVersion: 'v3',
      clock: { now: () => 2, setTimeout, clearTimeout }
    });

    const result = await next.synthesize({ text: 'Hello', language: 'en' });
    expect(result.cached).toBe(false);
    expect(processRunner.calls).toHaveLength(2);
    expect(cache.size).toBe(2);
  });

  test('ffmpeg failure removes the partial file and serves readable WAV with its real MIME type', async () => {
    const { filesystem, service } = build({ ffmpegError: true });
    const result = await service.synthesize({ text: 'Fallback', language: 'en' });

    expect(result).toMatchObject({ format: 'wav', mimeType: 'audio/wav', cached: false });
    expect(result.audio.toString()).toBe('wav:Fallback');
    expect([...filesystem.files.keys()].some((name) => name.endsWith('.part.m4a'))).toBe(false);
  });

  test('cache outages do not remove speech', async () => {
    const cache = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
    const { service } = build({ cache });
    await expect(service.synthesize({ text: 'Still speaks', language: 'en' }))
      .resolves.toMatchObject({ format: 'm4a', cached: false });
  });

  test('the requested language selects both model and speaker', async () => {
    const { processRunner, service } = build();
    await service.synthesize({ text: 'Hola', language: 'es-ES' });
    expect(processRunner.calls[0].args).toEqual(expect.arrayContaining([
      '--model', '/voices/es.onnx', '--speaker', '1'
    ]));
  });

  test('an unavailable language uses the default model without leaking its speaker id', async () => {
    const { processRunner, service } = build();
    await service.synthesize({ text: 'Hallo', language: 'de-DE' });
    expect(processRunner.calls[0].args).toEqual(expect.arrayContaining(['--model', '/voices/en.onnx']));
    expect(processRunner.calls[0].args).not.toContain('--speaker');
  });
});
