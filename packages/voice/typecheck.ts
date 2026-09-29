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
  voiceCacheSource,
  VOICE_FINISH,
  VOICE_LOUDNESS,
  buildReadingGraph,
  createReadingAssembler,
  buildResidentPiperArgs,
  createResidentPiperPool,
  createFileVoiceCache,
  createMicrophoneGate,
  createUtteranceSegmenter,
  runProcess,
  pcm16ToWav
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

const assembler = createReadingAssembler({ spawn, clock });
const pool = createResidentPiperPool({ spawn: () => ({}), partMaxMs: 1000 });
const fileCache = createFileVoiceCache({
  filesystem: {
    mkdir: async () => undefined,
    readFile: async () => new Uint8Array(),
    writeFile: async () => undefined,
    rename: async () => undefined,
    remove: async () => undefined,
    list: async () => [],
    modifiedAt: async () => 0,
    touch: async () => undefined
  },
  directory: '/voice',
  retainDays: 60
});
const gate = createMicrophoneGate({ vad: { classify: async () => 1, frameSize: 512 }, echo: { compare: async () => 0.1, dropAs: 'silence', silentRun: 64 } });
const segmenter = createUtteranceSegmenter({ transcribe: async () => ({ text: 'hello', confidence: 0.9 }) });
void [
  VOICE_FINISH, VOICE_LOUDNESS, buildReadingGraph([{ pitch: 1, after: 0.25 }]), assembler.assemble({ takes: [{ file: 'a.wav' }], output: 'o.m4a' }),
  buildResidentPiperArgs({ modelPath: 'voice.onnx' }), pool.say({ model: 'voice.onnx', pace: 1, pause: 0.3 }, 'Hello', 'o.wav'), pool.size,
  fileCache.get('key'), fileCache.prune(), gate.push('AAAA'), segmenter.push('AAAA'), segmenter.finish(),
  runProcess(spawn, 'ffmpeg', [], { clock, timeoutMs: 1000 }), pcm16ToWav(new Uint8Array(2), 24000),
  createProviderVoiceService({ providers: [], restingLast: true })
];
void exercise;
