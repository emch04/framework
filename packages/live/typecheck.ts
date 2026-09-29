import * as live from './src';

const state = live.nextCallState({ phase: 'connecting', reason: null, muted: false }, { type: 'ready' });
const message: string = live.encodeMessage({ type: 'text', text: 'sample' });
const decoded: live.CallMessage | null = live.decodeMessage(message);
const samples: Float32Array = live.pcm16ToFloat(live.floatToPcm16(new Float32Array([0, 0.5])));
const level: number = live.audioLevel(samples);
const confirmation = live.createSpokenConfirmation({ now: () => 0 });
confirmation.propose('action');
const answer: string = confirmation.verify('action', 'en');
const setup: unknown = live.geminiSetup({ model: 'model', instructions: 'test' });
const closeCode: number = live.CLOSE.AUTH;
const outcome: { kind: string; code?: string } = live.closeOutcome(4401);
const shield = live.createLiveShield({ maskText: (text) => text });
const quota = live.createMinuteQuota({ now: () => 0 });
const reader = live.createGeminiLiveReader({
  adapter: { connect: async () => ({ sendAudio() {}, sendText() {}, close() {} }) },
  clock: { now: () => 0, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} }
});
void [state, decoded, level, answer, setup, closeCode, outcome, shield, quota, reader];

const gate: live.MicrophoneGate = {
  push: async (data) => data,
  playbackSent: () => undefined,
  playbackInterrupted: () => undefined
};
const provider = live.createGeminiLiveAdapter({
  websocketFactory: () => ({}),
  candidates: () => [{ model: 'model', key: 'fake-' + 'key' }],
  clock: { now: () => 0, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
  maxImageChars: 100,
  gaveOut: ({ code }) => code === 1008,
  handover: ({ kind, turns }) => ({ text: `${kind}:${turns.length}`, turnComplete: kind === 'resume' }),
  toolError: (error) => ({ error: String(error) })
});
const hosted = live.createLiveSession({
  socket: { readyState: 1, send() {}, close() {} },
  context: { userId: 'user', role: 'person' },
  provider,
  clock: { now: () => 0, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
  instructions: async ({ mode }) => `mode ${mode}`,
  tools: { declarations: [], call: async () => ({}) },
  wire: { encode: (message) => (message.type === 'end' ? null : JSON.stringify(message)) },
  local: async () => ({ transcriber: { push: async () => [], finish: async () => [] } }),
  microphone: gate,
  directInterrupt: false,
  observe: () => undefined,
  onEnd: () => undefined
});
const relay = live.createTranscribedRelay({
  transcriber: { push: async () => [], finish: async () => [] },
  decision: {},
  send: () => undefined,
  onHeard: () => undefined,
  onSentence: () => undefined,
  onFallback: () => undefined,
  onUnavailable: () => undefined
});
void [hosted.history, relay.finish()];
