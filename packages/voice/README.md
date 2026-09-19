# @astratra/voice

Server-side text-to-speech finishing and caching without a bundled speech
engine. Piper, ffmpeg, the file system, the clock, and the cache are adapters;
tests therefore run in plain Node without Piper or ffmpeg installed.

## Pure builders shared by server and client

```js
const {
  VOICE_VERSION,
  buildVoiceCacheKey,
  buildPiperArgs,
  buildFfmpegArgs,
  mimeTypeForAudio
} = require('@astratra/voice');

const key = buildVoiceCacheKey(text, { language, version: VOICE_VERSION });
```

`VOICE_VERSION` is the single source of truth for both caches. Import it on
the server and in the client cache instead of copying a version literal. Bump
it whenever a model, speaker, pause, intonation setting, or finishing filter
changes; otherwise cached audio can preserve the old voice after deployment.

The default finishing chain is the production-proven mono AAC pipeline:
64 kb/s, 24 kHz, MP4 fast-start, equalizers at 160/3000/8000 Hz, high-pass,
de-esser, compressor, and -16 LUFS normalization. `mimeTypeForAudio` reports
`audio/mp4` for the finished M4A and `audio/wav` for the fallback.

The Piper builder defaults to `length_scale=0.92`,
`sentence_silence=0.35`, `noise_scale=0.73`, and `noise_w=0.92`. Speakers are
selected by normalized language:

```js
buildPiperArgs({
  modelPath: '/voices/es.onnx',
  outputPath: '/work/speech.wav',
  language: 'es-ES',
  speakers: { es: 1 }
});
```

## Synthesize, finish, cache

```js
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { createVoiceService } = require('@astratra/voice');

const service = createVoiceService({
  spawn,
  filesystem: {
    readFile: fs.readFile,
    rename: fs.rename,
    remove: (file) => fs.rm(file, { force: true })
  },
  cache: {
    // Decode/encode base64 here when the backing store only accepts strings.
    get: async (key) => redisGetVoice(key),
    set: async (key, entry, ttlSeconds) => redisSetVoice(key, entry, ttlSeconds)
  },
  models: { en: '/voices/en.onnx', es: '/voices/es.onnx' },
  defaultLanguage: 'en',
  speakers: { es: 1 },
  temporaryDirectory: '/tmp/voice'
});

const { audio, mimeType, cacheKey, cached } = await service.synthesize({ text, language });
```

Piper first writes WAV. ffmpeg writes a `.part.m4a`, which is renamed only
after a zero exit code. If finishing fails, the partial file is removed and
the WAV is returned. A cache outage is treated as a miss and never suppresses
speech. `createMemoryVoiceCache()` is provided for tests and local use.

The injected file adapter's `remove` method must be idempotent and return a
Promise. The injected `spawn` follows Node's `child_process.spawn` shape.

## Persistent Piper server contract

This package does not port or run a Python server. A persistent Piper server
used ahead of the CLI fallback should apply the same settings:

- `length_scale`: `0.92`
- `sentence_silence`: `0.35`, inserted between synthesized sentence chunks
- `noise_scale`: `0.73`
- `noise_w_scale`: `0.92`
- speaker selection by normalized language

The crucial server-side detail is that Piper returns one chunk per sentence:
`sentence_silence` must become zero-valued PCM between chunks (not merely be
read from configuration), or adjacent sentences run together.

## Intentionally out of scope

- no Piper, ffmpeg, Redis, filesystem, or HTTP dependency;
- no text normalization, language detection, user-facing copy, or app roles;
- no Python server implementation or provider-specific HTTP client;
- no cache eviction policy: the backing store owns retention beyond the TTL.

## Tests

```bash
npx jest packages/voice
```
