const {
  VOICE_FILTER,
  VOICE_VERSION,
  buildFfmpegArgs,
  buildPiperArgs,
  buildVoiceCacheKey,
  mimeTypeForAudio,
  voiceCacheSource
} = require('../src');

describe('ffmpeg finishing', () => {
  test('keeps the proven EQ, cleanup, AAC size and streaming rules together', () => {
    const args = buildFfmpegArgs('input.wav', 'output.m4a');
    expect(VOICE_FILTER).toContain('equalizer=f=160:t=q:w=0.9:g=2');
    expect(VOICE_FILTER).toContain('equalizer=f=3000:t=q:w=1.3:g=2');
    expect(VOICE_FILTER).toContain('equalizer=f=8000:t=q:w=1.5:g=-2.5');
    expect(VOICE_FILTER).toContain('highpass=f=70');
    expect(VOICE_FILTER).toContain('deesser=i=0.3');
    expect(VOICE_FILTER).toContain('loudnorm=I=-16:TP=-1.5:LRA=11');
    expect(args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '64k']));
    expect(args.slice(-3)).toEqual(['-movflags', '+faststart', 'output.m4a']);
    expect(args[args.indexOf('-af') + 1]).toBe(VOICE_FILTER);
  });

  test('announces the type of the bytes actually returned', () => {
    expect(mimeTypeForAudio('/tmp/voice.m4a')).toBe('audio/mp4');
    expect(mimeTypeForAudio('/tmp/voice.wav')).toBe('audio/wav');
  });
});

describe('Piper invocation', () => {
  test('keeps CLI pauses and intonation aligned with the persistent server', () => {
    const args = buildPiperArgs({ modelPath: '/voices/en.onnx', outputPath: '/tmp/out.wav', language: 'en' });
    expect(args).toEqual([
      '--model', '/voices/en.onnx',
      '--output_file', '/tmp/out.wav',
      '--length_scale', '0.92',
      '--sentence_silence', '0.35',
      '--noise_scale', '0.73',
      '--noise_w', '0.92'
    ]);
  });

  test('selects a speaker per normalized language and does not invent one', () => {
    expect(buildPiperArgs({
      modelPath: '/voices/es.onnx', outputPath: '/tmp/es.wav', language: 'es-ES', speakers: { es: 1 }
    }).slice(-2)).toEqual(['--speaker', '1']);
    expect(buildPiperArgs({
      modelPath: '/voices/en.onnx', outputPath: '/tmp/en.wav', language: 'en', speakers: { es: 1 }
    })).not.toContain('--speaker');
  });
});

describe('shared voice cache identity', () => {
  test('the same text and language have one file-safe key', () => {
    const first = buildVoiceCacheKey('Hello there', { language: 'en-US' });
    expect(first).toBe(buildVoiceCacheKey('Hello there', { language: 'en' }));
    expect(first).toMatch(/^[a-z0-9-]+$/);
  });

  test('version, language and the whole text each invalidate the key', () => {
    const base = buildVoiceCacheKey('Score: 12', { language: 'en', version: 'v2' });
    expect(buildVoiceCacheKey('Score: 13', { language: 'en', version: 'v2' })).not.toBe(base);
    expect(buildVoiceCacheKey('Score: 12', { language: 'es', version: 'v2' })).not.toBe(base);
    expect(buildVoiceCacheKey('Score: 12', { language: 'en', version: 'v3' })).not.toBe(base);
    expect(voiceCacheSource('Score: 12')).toContain(VOICE_VERSION);
  });

  test('nearby long responses do not collide', () => {
    const prefix = 'x'.repeat(5000);
    expect(buildVoiceCacheKey(`${prefix}a`)).not.toBe(buildVoiceCacheKey(`${prefix}b`));
    const keys = new Set(Array.from({ length: 20000 }, (_, index) => buildVoiceCacheKey(`Response ${index}`)));
    expect(keys.size).toBe(20000);
  });
});
