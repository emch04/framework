import {
  VOICE_FILTER,
  VOICE_VERSION,
  buildFfmpegArgs,
  measuredLoudness,
  buildPiperArgs,
  buildVoiceCacheKey,
  createMemoryVoiceCache,
  createVoiceService,
  createProviderVoiceService,
  createPiperProvider,
  createGeminiTtsAdapter,
  classifyProviderError,
  createVadSegmenter,
  createVadSpeechGate,
  createEchoGuard,
  chainEchoGuards,
  appendTrailingSilence,
  confidenceFromLogProbabilities,
  analyzeTranscription,
  isDoubtfulTranscription,
  createLocalTranscriber,
  createTranscriptionProviderChain,
  createConfidentialPolicy,
  createConfidentialSession,
  createSpeechChunker,
  compareSpokenText,
  hasSpeechDrift,
  buildExpectedVocabulary,
  splitSpeechPieces,
  createPieceVoiceService,
  mimeTypeForAudio,
  normalizeLanguage,
  voiceCacheSource
} from './src';
import type {
  Spawn,
  VoiceCache,
  VoiceClock,
  VoiceFilesystem,
  VoiceResult,
  VoiceService
} from './src';

const cache: VoiceCache = createMemoryVoiceCache();
const files = new Map<string, Uint8Array>();
const filesystem: VoiceFilesystem = {
  readFile: async (name) => files.get(name) || new Uint8Array(),
  rename: async (from, to) => { files.set(to, files.get(from) || new Uint8Array()); },
  remove: async (name) => { files.delete(name); }
};
const spawn: Spawn = (_command, _args) => ({
  stdin: { write: () => undefined, end: () => undefined },
  stderr: { on: () => undefined },
  on: () => undefined,
  kill: () => undefined
});
const clock: VoiceClock = {
  now: () => 1,
  setTimeout: () => 1,
  clearTimeout: () => undefined
};

const service: VoiceService = createVoiceService({
  spawn,
  filesystem,
  cache,
  models: { en: '/voices/en.onnx' },
  defaultLanguage: 'en',
  speakers: { en: 1 },
  clock
});

async function exercise(): Promise<void> {
  const result: VoiceResult = await service.synthesize({ text: 'Hello', language: 'en-US' });
  const chain = createProviderVoiceService({ providers: [createPiperProvider(service)], cache });
  const segmenter = createVadSegmenter({ classify: async () => 1 });
  const guard = createEchoGuard({ compare: async () => 0.9 });
  const local = createLocalTranscriber({ transcribe: async () => ({ text: 'hello', confidence: 0.9 }) });
  const policy = createConfidentialPolicy({ defaultRoles: ['restricted'] });
  const session = createConfidentialSession(policy, { role: 'restricted' });
  const gemini = createGeminiTtsAdapter({
    fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    endpoint: (model) => `https://example.invalid/${model}`,
    models: ['one'], voices: { en: 'voice' }, keys: ['fake-' + 'key']
  });
  void [
    chain.synthesize({ text: 'Hello' }), segmenter.push(new Float32Array(512)),
    createVadSpeechGate().push(new Float32Array(512)),
    guard.filter(new Float32Array(512)), local.transcribe(new Float32Array(512)),
    chainEchoGuards(guard).filter(new Float32Array(512)),
    createTranscriptionProviderChain({ providers: [{ id: 'local', transcribe: async () => 'hello' }] }).transcribe(new Uint8Array()),
    policy.decide({ role: 'restricted' }),
    session.onDoubt(), gemini.id, classifyProviderError({ status: 429 }),
    createSpeechChunker({ abbreviations: [] }).push('Ready. Next'),
    compareSpokenText('a b', 'a b'), hasSpeechDrift('a b', 'a'),
    buildExpectedVocabulary([['alpha']]),
    splitSpeechPieces('Hello. Next.'),
    createPieceVoiceService({ providers: [{ id: 'local', synthesize: async ({ text }) => text }] }).synthesize(['hello']),
    appendTrailingSilence(new Int16Array(16)),
    confidenceFromLogProbabilities([-0.5]),
    analyzeTranscription('hello', 1000), isDoubtfulTranscription('', 1000),
    result.audio,
    result.mimeType,
    VOICE_FILTER,
    VOICE_VERSION,
    buildFfmpegArgs('in.wav', 'out.m4a'),
    measuredLoudness('{}'),
    buildPiperArgs({ modelPath: 'voice.onnx', outputPath: 'out.wav' }),
    buildVoiceCacheKey('Hello', { language: 'en' }),
    voiceCacheSource('Hello'),
    mimeTypeForAudio('m4a'),
    normalizeLanguage('en-US')
  ];
}

void exercise;
