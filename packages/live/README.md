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

## Confidential path

`local` supplies `transcribe`, a `thinker` or injected `textModel`, and a `reader` or voice provider list. `createTextThinker` and `createGeminiTextModel` are available for a streaming text model with tool rounds and candidate fallback. `createGeminiLiveReader` gathers Live audio, checks spoken words against requested text through `@astratra/voice`, and falls back through injected TTS providers. The call uses `@astratra/voice` for VAD segmentation, echo filtering, local transcript analysis, confidential fallback policy, and TTS chunking. Configure `createConfidentialPolicy` from `@astratra/voice` to lock roles or permit explicit cloud fallback. A doubtful transcript emits `repeat` and never reaches the model. The host owns its local decoder, text model, voice provider, and playback format. If a role cannot use cloud audio and local dependencies are absent, the call ends with `LOCAL_UNAVAILABLE`.

## Client protocol

`encodeMessage` and `decodeMessage` handle JSON messages. `nextCallState` tracks connecting, listening, thinking, speaking, confirming, reconnecting, and ended phases. `floatToPcm16`, `pcm16ToFloat`, base64 helpers, `resample`, `encodeMicroChunk`, `decodeVoiceChunk`, `audioLevel`, `shouldInterrupt`, and `createAudioPacer` cover the 16 kHz microphone / 24 kHz playback pattern. The default pacer sends 25 chunks per second and bounds its queue. All client messages use `type` and optional fields; reason codes are stable and should be rendered through the host's catalog.

## Error and persistence boundaries

Authentication, action storage, transcript storage, quota storage, logger, WebSocket implementation, and clock are injected. The package does not store secrets, connect to a database, or choose a locale. Transcript and memory failures are reported through the injected logger and do not expose provider errors to callers. A failed provider setup closes with `PROVIDER_UNAVAILABLE`.
