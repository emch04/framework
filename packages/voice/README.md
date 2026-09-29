# @astratra/voice

Speech synthesis, segmentation, echo filtering, local transcription helpers,
and session privacy policy without bundled models or engines. Providers,
keys, storage, clock, network, classifiers, and decoders are injected.

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
`measuredLoudness` converts a valid first-pass ffmpeg loudness report into
second-pass measured parameters and otherwise returns the configured target.

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

`VOICE_FILTER` is the finish (`VOICE_FINISH`: equalizers, high-pass, de-esser,
compressor) followed by the loudness step (`VOICE_LOUDNESS`). They are exported
apart because a reading assembled from several takes is normalized in two
passes (see "Assemble a reading" below).

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

## Assemble a reading, resident Piper, readings on disk

A long reading is often several takes: a piece per group of sentences read in
the cloud, or a part per tone read by Piper. `createReadingAssembler({ spawn,
ffmpegPath })` joins them into one finished AAC file. Each take
(`{ file, pitch, after }`) is brought to its pitch (a lower voice is played at
another rate and brought back to time, so the pace is kept) and to one rate,
followed by its silence; then come the finish (none for a voice already
finished) and the loudness in two passes: the first measures the whole reading,
the second applies one steady gain (`measuredLoudness`). One pass lets loudnorm
find its level while it reads, and the first seconds come out too loud.
`buildReadingGraph` gives the ffmpeg graph alone.

`createResidentPiperPool({ spawn, piperPath })` keeps Pipers in memory, one per
voice and delivery (`{ model, pace, pause }`), started once and handed each
text as a line of JSON (`buildResidentPiperArgs` shares the delivery of the
command line). A Piper started for each text spends half a second loading its
voice. One that dies or hangs is dropped and its next text starts a new one.
`warm(models, deliveries, { file, cleanup })` starts them all and has each say
a word, so the first reading does not pay for it.

`createFileVoiceCache({ filesystem, directory, retainDays })` keeps each
finished reading as a file under its key (`keyPattern` decides what a key is,
so a key can never name a path). A reading heard again is touched; one not heard
for `retainDays` (60) is removed by `prune`, which a write runs by itself at
most every six hours. It is a `VoiceCache`, so `get` gives
`{ audio, format, mimeType }`.

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

## Provider chain

`createProviderVoiceService({ providers, cache, clock, cooldownMs,
voiceVersion })` tries providers in order. Each provider can declare ordered
`models`, `keys`, and `synthesize({ text, language, voice, model, key })`.
Keys rotate across calls. Quota/429 rests the specific provider, model and key
for one hour by default. `cooldownStore` can persist that rest between service
instances; `usageStore` can limit successful keyed calls per UTC day (nine by
default). `cooldownMsByCode` can set rest times for `AUTH` or `TRANSIENT`
failures. Failed optional stores do not prevent synthesis.

`restingLast` keeps candidates at rest from being skipped: every model on every
key is tried, those at rest after the others, so a blip that rested all the keys
does not send every reading to the local voice for the length of the rest.
`cooldownMsByCode` can rest any kind of failure (`QUOTA`, `AUTH`, `TRANSIENT`,
`PROVIDER_ERROR`: a refused key answers 400 as often as 403).

Cache identity includes text, language, provider, selected voice and the
caller's voice version. A cached fallback cannot masquerade as the primary
voice. The result includes `provider`, `model`, `fallback`, and `attempts`
with error codes only. A `fallbackScope` plus injected `fallbackStore` can
pin a caller's later synthesis to the same fallback provider for five minutes
by default. This avoids changing voice inside one response. Keys are hashed
in store identifiers and omitted from attempts and errors.

```js
const { createProviderVoiceService, createPiperProvider,
  createGeminiTtsAdapter } = require('@astratra/voice');

const cloud = createGeminiTtsAdapter({
  fetch: injectedFetch,
  endpoint: (model) => configuredEndpoint(model),
  model: configuredModel,
  voice: configuredVoice,
  keys: () => configuredKeys()
});
const service = createProviderVoiceService({
  providers: [cloud, createPiperProvider(piperService)],
  cache: voiceCache,
  clock: injectedClock,
  cooldownStore: injectedCooldownStore,
  usageStore: injectedUsageStore,
  fallbackStore: injectedFallbackStore,
  voiceVersion: configuredVoiceVersion
});

const spoken = await service.synthesize({
  text, language, voiceVersion: currentVoiceVersion,
  fallbackScope: conversationId
});
```

The optional Gemini adapter uses the source `generateContent` speech request
shape (snake case by default, camel case via `wireStyle`), converts mono 16-bit
PCM to WAV or accepts a WAV response, selects a voice from `voices[language]`
or an explicit request, and puts the key in a header. Its `fetch`, endpoint,
model names, voices and keys are supplied by the caller. HTTP 429, 401/403,
server and timeout errors classify as `QUOTA`, `AUTH` or `TRANSIENT`.
Applications supply any user-facing text.

## Segmentation, echo, transcription and privacy

`createVadSegmenter` accepts normalized PCM in order. With `frameSize`, it
buffers partial frames and processes multiple frames in one `push`; without
it, each push is one frame. `classify(frame)` may return a model probability;
the default uses frame energy. It has configurable start, minimum speech,
hangover, pre-roll and maximum segment frames. A classifier failure switches
to energy. `push` returns completed `Float32Array` segments; `flush` emits a
final segment and `reset` discards buffered audio.
`createVadSpeechGate` is the continuous variant: it preserves stream timing by
replacing rejected frames with equal-length silence, with lookback and hangover.
If its injected classifier fails, it releases held audio and passes subsequent
audio through.

`createMicrophoneGate({ vad, echo })` chains the two for base64 16-bit PCM in and
out, as a phone sends it: first the speech gate (noise becomes silence of the
same length, so a model still hears the time go by and knows when the person has
stopped), then the echo guard, whose dropped sound is silence too. A chunk that
goes through unchanged comes out as it went in, to the bit. `vad` and `echo` are
the options of `createVadSpeechGate` and `createEchoGuard`, or gates already
made; `playbackSent` and `playbackInterrupted` tell the guard when the
assistant's voice plays.

`createEchoGuard({ compare, now, threshold, tailMs, minSamples,
windowSamples, passGapMs, silentRun, dropAs, latchOnFailure })` accepts playback duration through `playbackSent(bytes,
sampleRate)`, extends queued playback, and retains an echo tail after
`playbackInterrupted()`. `inspect(segment)` returns a segment or `null` with a
reason code. `push(segment)` can hold sequential audio up to a comparison
window. Matching audio is dropped; too-short held audio may be dropped
conservatively. Exact silence is excluded from speaker comparison; a
different speaker continues without a second comparison for as long as its
chunks come without a pause longer than the pass gap. The window fills with sound
only (`silentRun`: exact silence at least that many samples long is left out; the
default 1 leaves out every zero sample). `dropAs: 'silence'` returns what is
dropped as silence of the same length, so a stream keeps its timing. After a
comparator failure the guard stops comparing and everything passes
(`latchOnFailure`). The existing `setPlaying` and `filter` methods remain. With
no comparator or a comparator failure, audio passes through. The host
supplies the speaker comparator and audio clock.
`chainEchoGuards(...guards)` applies several optional audio guards in order
and forwards playback events to each one.

`appendTrailingSilence` pads float PCM, `Int16Array` PCM or little-endian
PCM16 bytes by 500 ms at the supplied sample rate. `createLocalTranscriber`
normalizes PCM16 for an injected decoder and returns `{ text, durationMs,
doubtful, reason, confidence }`. `analyzeTranscription` (and its boolean
wrapper `isDoubtfulTranscription`) checks empty text, caller-supplied stock
phrases by language, sparse words, repeated words or phrases, non-word ratio,
model log probability, no-speech probability and echoes of injected expected
vocabulary. Heuristics return reason codes and a low confidence value; they
are not proof of transcription quality. `confidenceFromLogProbabilities`
converts a decoder's token log probabilities to a bounded score when present.
`createUtteranceSegmenter({ transcribe })` cuts a microphone into what the person
said, one sentence at a time, on base64 PCM16 that a speech gate has already
sorted: a frame is speech when its energy passes `threshold`, a pause shorter
than `silenceMs` (520) stays inside the sentence, a longer one ends it and is
not decoded, a sentence shorter than `minSpeechMs` (240) is noise. Each sentence
is decoded by the injected `transcribe` (`createLocalTranscriber`'s fits) and
comes back with its `text`, `confidence` and the sentence itself as `audio`, so a
caller that gives up on the local decoder can replay it. A decoder that fails
rejects with that audio in the error, and the sentences after it go on.
`createTranscriptionProviderChain` tries injected transcribers in order. It
first asks each to detect language; if that result is absent or outside the
caller-supplied supported list, it can retry in the requested language. A
failed or empty result moves to the next provider and returns provider and
fallback codes. Each provider is also given `requestedLanguage`, what the caller
asked for, for one that cannot listen freely: it may answer in that language and
say so in `heardLanguage`, and no second decoding follows. Cloud HTTP clients and model choices remain caller owned.

`createConfidentialPolicy({ defaultRoles, lockedRoles, cloudFallbackRoles,
localUnsupportedLanguages })` returns session decisions with `mode`,
`cloudAudioAllowed`, and a reason code. An unlocked session may override its
default. A locked role stays confidential. Local failure may enable cloud
audio only when the role is allowed and the session explicitly opts in.
`createConfidentialSession(policy, session)` tracks accepted, doubtful and
failed local transcriptions, falls back after repeated doubt where allowed,
and ends after repeated local failures where cloud is forbidden. Integrators
must enforce `cloudAudioAllowed` before sending any audio to a provider.

`createSpeechChunker` releases complete sentences from streamed text, with an
injected abbreviation list and a configurable length limit. `compareSpokenText`
measures ordered precision and coverage; `hasSpeechDrift` applies separate
partial and final thresholds. `buildExpectedVocabulary` merges injected term
lists within a character budget. No language or product vocabulary is bundled.

`splitSpeechPieces` groups whole sentences under an injected size limit.
`createPieceVoiceService` synthesizes pieces with bounded concurrency. If any
piece fails, it waits for active work, discards every piece from that provider,
and retries the whole reading with the next injected provider. It returns the
ordered pieces and the provider that completed them, preventing mixed voices
within a reading. Combining audio and applying pauses remain caller owned.

## Intentionally out of scope

- no Piper, ffmpeg, Redis, filesystem, or HTTP dependency (Node's `spawn` and
  file system are injected, so the assembler, the resident pool and the file
  cache run against fakes in tests);
- no text normalization, language detection, user-facing copy, or fixed app roles;
- no Python server implementation or bundled network client;
- no model files, ONNX, sherpa, or Whisper bindings;
- no cache eviction policy for the memory and injected caches: the backing store
  owns retention beyond the TTL (the file cache prunes by age).

## Tests

```bash
npx jest packages/voice
```
