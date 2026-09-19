import {
  VOICE_FILTER,
  VOICE_VERSION,
  buildFfmpegArgs,
  buildPiperArgs,
  buildVoiceCacheKey,
  createMemoryVoiceCache,
  createVoiceService,
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
  void [
    result.audio,
    result.mimeType,
    VOICE_FILTER,
    VOICE_VERSION,
    buildFfmpegArgs('in.wav', 'out.m4a'),
    buildPiperArgs({ modelPath: 'voice.onnx', outputPath: 'out.wav' }),
    buildVoiceCacheKey('Hello', { language: 'en' }),
    voiceCacheSource('Hello'),
    mimeTypeForAudio('m4a'),
    normalizeLanguage('en-US')
  ];
}

void exercise;
