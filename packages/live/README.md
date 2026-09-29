# @astratra/live

Composable real-time voice calls for Node 20 or newer. All application state, identity, network transports, models, and user-facing wording are supplied by the host. The client protocol helpers are plain JavaScript for browser and React Native clients.

## Installation

```sh
npm install @astratra/live @astratra/voice @astratra/ai
```

## Server

`attachLive` accepts an HTTP server, a WebSocket server in `noServer` mode, an authentication function, an optional `authorize(request, context)` guard for origin and entitlement checks, and a `createSession` factory. The package does not create servers, read environment variables, or load keys.

```js
const { attachLive, createLiveSession, createGeminiLiveAdapter } = require('@astratra/live');

const provider = createGeminiLiveAdapter({
  websocketFactory: (url) => makeWebSocket(url),
  candidates: [{ model: configuredModel, key: configuredKey }],
  clock
});

const binding = attachLive({
  httpServer,
  websocketServer,
  authenticate: verifyUpgrade,
  createSession: ({ socket, context }) => createLiveSession({
    socket, context, provider, clock, registry, actions,
    transcripts, quota, memory, local, policy, shield,
    persona: configuredPersona, catalog
  })
});
```

The provider contract is `connect({ instructions, tools, earlier, mode, onEvent, onClose }) -> Promise<line>`. A line implements `sendAudio`, `sendText`, and `close`; image, mute, and interrupt methods are optional. The Gemini adapter accepts an injected WebSocket factory and ordered `{ model, key }` candidates. It sends setup, audio, text, image, and tool response messages using the Gemini Live wire shape, resumes with a handle when possible, and tries later candidates after failure. Supply keys at runtime; do not log adapter URLs.

`transcripts` supports `get(id, userId)`, `latest(userId)`, `create({ userId, updatedAt, turns })`, and `append(id, userId, turns, updatedAt)`. Records must include `id`, `userId`, `updatedAt` in milliseconds, and `turns`. A requested conversation is resumed only while fresh within `resumeWindowMs` (30 minutes by default); lookup failures start a fresh conversation. `resumeTurns` bounds the history sent to a new call (12 turns by default). `transcriptCompleteOnly` and `deferLatestExchange` select whether to wait for a reply or another exchange before persisting. `annotateToolResult(name, result)` can attach host-defined source references or cards to the next assistant turn. After the call, `memory.consolidate(where, { transcript, ref })` is invoked in the background when present.

`quota` is created with `createMinuteQuota({ store, limits, now })`. The injected store has `usedMs(userId, plan, role)` and `addMs(userId, plan, role, ms)`; group limits additionally use `usedGroupMs(groupId, plan)` and `addGroupMs(groupId, plan, ms)`. Set `limits` by plan and role, and `limits.groups` by plan. Absent limits mean unlimited. The session debits while running, emits `QUOTA_WARNING`, and ends with `QUOTA_EXHAUSTED` or `GROUP_LIMIT`. Storage errors fall back to process memory. Use an atomic shared store for concurrent production calls. `createCallLease` accepts a shared get/set/delete store to replace older calls across processes. `createDailyCounter` provides a generic UTC-day counter for provider usage limits.

The `registry` follows `@astratra/ai`'s `ToolRegistry` contract. The `actions` adapter queues and executes write actions. A spoken confirmation needs a proposed action, assistant readback, and recognized affirmative answer with no negative answer. Supply language-specific `catalog.affirmative` and `catalog.negative` phrase arrays. The same pending action can be confirmed by an explicit client `confirm` message. `createLiveShield` composes injected text masking, unmasking, outbound redaction, and structural key filtering. Its `input`/`output` hooks protect model speech, while `args`/`result` protect local tool calls and `external` protects third-party tool arguments. Supply an injected `catalog` and `persona` for instructions and repeat prompts; the package emits codes rather than fixed user-facing sentences.

## A host with its own prompt, tools and protocol

`createLiveSession` takes what a host already has instead of the package's
defaults:

- `instructions`: the whole text (or a function making it when the call starts,
  given `{ context, mode }`), instead of `persona` and `catalog`. The shield
  still masks it.
- `tools`: `{ declarations, call({ id, name, args }) }` (or a function making it
  when the call starts) instead of `registry` and `actions`. What
  `annotateToolResult` returns is still attached to the reply that follows.
- `wire`: `{ encode(message), decode(raw) }` for a client that speaks other
  shapes (a message renamed, reshaped, or left unsent by returning `null`).
  `attachLive` takes the same `encode` for what it sends by itself (a refused
  call: `{ type: 'error', reason: 'BUSY' }`).
- `microphone`: options for `createMicrophoneGate` of `@astratra/voice`
  (`{ vad, echo }`), a gate, or a function making either when the call starts.
  The sound goes through it before the provider or the local transcription;
  the provider's voice tells it when it plays, so the echo guard knows when to
  listen. A filter that cannot be made, or throws, never stands in the call's
  way.
- `observe(message)`: every message the session sends, as the session writes
  it; `onEnd({ reason, code, turns, conversationId, ... })`: once, after the
  client is let go (a host writes its logs there without delaying the hang-up).
- `directInterrupt: false`: a client's `interrupt` is not sent to a provider
  that hears the person itself.
- `transcripts.create` is given `first`, the first thing the person said, to
  title the conversation; `saved` reaches the client even when the call is
  closing.

A call is alive while the person or the assistant does something (words, a photo
taken, the assistant's voice, a tool at work), not while the microphone runs: the
sound alone does not keep a call open.

The Gemini adapter takes `candidates` as a function (asked again at every change
of line, for keys that are reloaded while the server runs); `gaveOut` decides
whether a refusal or a cut was the key's fault (default: code 1008, or a reason
that speaks of a quota, a key, a limit): the key rests and the next one takes
over, otherwise the same key picks the line up with its handle. Once a line
opens, what failed before may be tried again at the next change. A new session
knows nothing, so it is told what was said: `handover({ kind, turns })` words it
(`resume`: the first line of a call that goes on with a conversation, the
assistant speaks first; `switch`: another line of the same call, it waits for the
person). The tools Google asks for at once run at once; `toolError(error)` words
the answer for one that throws; `maxImageChars` bounds a photo.

## Confidential path

`local` supplies `transcribe`, a `thinker` or injected `textModel`, and a `reader` or voice provider list. `createTextThinker` and `createGeminiTextModel` are available for a streaming text model with tool rounds and candidate fallback. `createGeminiLiveReader` gathers Live audio, checks spoken words against requested text through `@astratra/voice`, and falls back through injected TTS providers. The call uses `@astratra/voice` for VAD segmentation, echo filtering, local transcript analysis, confidential fallback policy, and TTS chunking. Configure `createConfidentialPolicy` from `@astratra/voice` to lock roles or permit explicit cloud fallback. A doubtful transcript emits `repeat` and never reaches the model. The host owns its local decoder, text model, voice provider, and playback format. If a role cannot use cloud audio and local dependencies are absent, the call ends with `LOCAL_UNAVAILABLE`.

The other confidential path keeps the provider's voice: `local` gives only a
`transcriber` (`{ push(base64), finish() }`, for instance
`createUtteranceSegmenter` of `@astratra/voice`), the sound is transcribed on
the server, sentence by sentence, and the provider receives text and answers
with its own voice and tools (`createTranscribedRelay`). The person sees what was
heard; a doubtful sentence is never sent, `repeat` is emitted, and after
repeated doubt (or a decoder that fails) the policy may move the call to normal
without opening a new line: the sound goes to the provider as it is, the last
sentence replayed first. `local` may be a function, asked once when a
confidential call starts: one that throws (a model that will not load) is a local
path that is not there, and the policy decides between `fallback` and
`LOCAL_UNAVAILABLE`, before the instructions are made, so they are written for
the mode the call really has.

## Client protocol

`encodeMessage` and `decodeMessage` handle JSON messages. `nextCallState` tracks connecting, listening, thinking, speaking, confirming, reconnecting, and ended phases. `floatToPcm16`, `pcm16ToFloat`, base64 helpers, `resample`, `encodeMicroChunk`, `decodeVoiceChunk`, `audioLevel`, `shouldInterrupt`, and `createAudioPacer` cover the 16 kHz microphone / 24 kHz playback pattern. The default pacer sends 25 chunks per second and bounds its queue. All client messages use `type` and optional fields; reason codes are stable and should be rendered through the host's catalog.

## Error and persistence boundaries

Authentication, action storage, transcript storage, quota storage, logger, WebSocket implementation, and clock are injected. The package does not store secrets, connect to a database, or choose a locale. Transcript and memory failures are reported through the injected logger and do not expose provider errors to callers. A failed provider setup closes with `PROVIDER_UNAVAILABLE`.
