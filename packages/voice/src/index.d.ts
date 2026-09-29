import type { Buffer } from 'node:buffer';

export type Awaitable<T> = T | Promise<T>;

export const VOICE_VERSION: 'v2';
export const VOICE_FILTER: string;
export const VOICE_FINISH: string;
export const VOICE_LOUDNESS: string;

export interface FfmpegOptions {
  filter?: string;
  channels?: number;
  sampleRate?: number;
  codec?: string;
  bitrate?: string;
}

export function buildFfmpegArgs(inputPath: string, outputPath: string, options?: FfmpegOptions): string[];
export function measuredLoudness(report: unknown, target?: string): string;

export interface PiperOptions {
  modelPath: string;
  outputPath: string;
  language?: string;
  speakers?: Record<string, string | number | null | undefined>;
  speaker?: string | number | null;
  lengthScale?: number;
  sentenceSilence?: number;
  noiseScale?: number;
  noiseW?: number;
}

export function buildPiperArgs(options: PiperOptions): string[];
export function normalizeLanguage(language?: unknown, fallback?: string): string;
export function voiceCacheSource(text: unknown, options?: { language?: string; version?: string }): string;
export function buildVoiceCacheKey(text: unknown, options?: { language?: string; version?: string }): string;
export function mimeTypeForAudio(pathOrExtension: unknown): 'audio/mp4' | 'audio/wav';

export interface VoiceCacheEntry {
  audio: Uint8Array;
  format: 'm4a' | 'wav';
  mimeType: 'audio/mp4' | 'audio/wav';
}

export interface VoiceCache {
  get(key: string): Awaitable<VoiceCacheEntry | null | undefined>;
  set(key: string, entry: VoiceCacheEntry, ttlSeconds: number): Awaitable<unknown>;
  delete?(key: string): Awaitable<boolean>;
}

export interface MemoryVoiceCache extends VoiceCache {
  delete(key: string): Promise<boolean>;
  clear(): void;
  readonly size: number;
}

export function createMemoryVoiceCache(): MemoryVoiceCache;

export interface SpawnedProcess {
  stdin?: { write(value: string): unknown; end(): unknown };
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown };
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill?(signal?: string): unknown;
}

export type Spawn = (command: string, args: string[]) => SpawnedProcess;

export interface VoiceFilesystem {
  readFile(path: string): Awaitable<Uint8Array>;
  rename(from: string, to: string): Awaitable<unknown>;
  remove(path: string): Promise<unknown>;
}

export interface VoiceClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VoiceServiceOptions {
  spawn: Spawn;
  filesystem: VoiceFilesystem;
  cache: VoiceCache;
  models: Record<string, string>;
  defaultLanguage?: string;
  speakers?: Record<string, string | number | null | undefined>;
  voiceVersion?: string;
  temporaryDirectory?: string;
  timeoutMs?: number;
  cacheTtlSeconds?: number;
  piperPath?: string;
  ffmpegPath?: string;
  piper?: Omit<PiperOptions, 'modelPath' | 'outputPath' | 'language' | 'speakers'>;
  ffmpeg?: FfmpegOptions;
  clock?: VoiceClock;
}

export interface VoiceResult extends VoiceCacheEntry {
  cacheKey: string;
  cached: boolean;
}

export interface VoiceService {
  readonly voiceVersion: string;
  synthesize(request: { text: unknown; language?: string }): Promise<VoiceResult>;
}

export function createVoiceService(options: VoiceServiceOptions): VoiceService;
export function runProcess(spawn: Spawn, command: string, args: string[], options: { clock: Pick<VoiceClock, 'setTimeout' | 'clearTimeout'>; timeoutMs: number; input?: string }): Promise<string>;

export function buildReadingGraph(takes: Array<{ pitch?: number; after?: number }>, options?: { sampleRate?: number; sourceRate?: number; finish?: string | null; loudness?: string }): string;
export function createReadingAssembler(options: {
  spawn: Spawn;
  ffmpegPath?: string;
  clock?: VoiceClock;
  timeoutMs?: number;
  sampleRate?: number;
  sourceRate?: number;
  bitrate?: string;
}): {
  assemble(reading: { takes: Array<{ file: string; pitch?: number; after?: number }>; output: string; finish?: string | null }): Promise<{ output: string }>;
};

export function buildResidentPiperArgs(options: { modelPath: string; lengthScale?: number; sentenceSilence?: number; noiseScale?: number; noiseW?: number; speaker?: string | number | null }): string[];
export function createResidentPiperPool(options: {
  spawn: (command: string, args: string[], options?: object) => any;
  piperPath?: string;
  partMaxMs?: number;
  clock?: Pick<VoiceClock, 'setTimeout' | 'clearTimeout'>;
  noiseScale?: number;
  noiseW?: number;
}): {
  say(voice: { model: string; pace: number; pause: number; speaker?: string | number | null }, text: string, file: string): Promise<void>;
  warm(models: string[], deliveries: Array<{ pace: number; pause: number; speaker?: string | number | null }>, options: { text?: string; file(count: number): string; cleanup?(file: string): Awaitable<unknown> }): void;
  readonly size: number;
};

export interface FileVoiceCache extends VoiceCache {
  delete(key: string): Promise<boolean>;
  prune(at?: number): Promise<number>;
}
export function createFileVoiceCache(options: {
  filesystem: {
    mkdir(directory: string): Promise<unknown>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array | string): Promise<unknown>;
    rename(from: string, to: string): Promise<unknown>;
    remove(path: string): Promise<unknown>;
    list(directory: string): Promise<string[]>;
    modifiedAt(path: string): Promise<number | null>;
    touch(path: string): Promise<unknown>;
  };
  directory: string;
  extension?: string;
  keyPattern?: RegExp;
  retainDays?: number;
  pruneEveryMs?: number;
  now?: () => number;
  initialFiles?: Record<string, string>;
}): FileVoiceCache;

export interface VoiceProvider {
  id?: string;
  voice?: string;
  model?: string;
  models?: string[];
  keys?: string[] | (() => Awaitable<string[]>);
  synthesize(request: { text: string; language: string; voice?: string | null; model?: string; key?: string; [key: string]: unknown }): Awaitable<VoiceCacheEntry>;
}
export interface ProviderVoiceOptions {
  providers: VoiceProvider[];
  cache?: VoiceCache;
  clock?: Pick<VoiceClock, 'now'>;
  cooldownStore?: { getCooldown(id: string): Awaitable<number | null | undefined>; setCooldown(id: string, untilMs: number): Awaitable<unknown> };
  usageStore?: { getCount(dayAndKeyId: string): Awaitable<number>; increment(dayAndKeyId: string): Awaitable<unknown> };
  fallbackStore?: { get(scope: string): Awaitable<string | null | undefined>; set(scope: string, providerId: string, ttlSeconds: number): Awaitable<unknown> };
  cooldownMs?: number;
  cooldownMsByCode?: Record<string, number>;
  maxSuccessesPerDay?: number;
  fallbackTtlSeconds?: number;
  voiceVersion?: string;
  cacheTtlSeconds?: number;
  /** Candidates at rest are not skipped: they are tried last, after every other (default false). */
  restingLast?: boolean;
}
export interface ProviderAttempt { provider: string; model?: string | null; code: string }
export interface ProviderVoiceResult extends VoiceResult {
  provider: string;
  model?: string | null;
  fallback: boolean;
  attempts: ProviderAttempt[];
}
export function classifyProviderError(error: { status?: number; code?: string | number; name?: string } | null | undefined): string;
export function createProviderVoiceService(options: ProviderVoiceOptions): {
  voiceVersion: string;
  synthesize(request: { text: unknown; language?: string; voice?: string; voiceVersion?: string; fallbackScope?: string }): Promise<ProviderVoiceResult>;
};
export function createPiperProvider(service: VoiceService, id?: string): VoiceProvider;
export function pcm16ToWav(pcm: Uint8Array, rate: number): Buffer;
export function createGeminiTtsAdapter(options: {
  fetch: (url: string, init: object) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  endpoint: (model: string) => string;
  model?: string;
  models?: string[];
  voice?: string;
  voices?: Record<string, string>;
  id?: string;
  keys?: string[] | (() => Awaitable<string[]>);
  timeoutMs?: number;
  wireStyle?: 'snake' | 'camel';
}): VoiceProvider;

export function energyClassifier(frame: ArrayLike<number>, threshold?: number): number;
export interface VadSegmenter {
  push(frame: ArrayLike<number>): Promise<Float32Array[]>;
  flush(): Float32Array[];
  reset(): void;
}
export function createVadSegmenter(options?: {
  classify?: (frame: Float32Array) => Awaitable<number>;
  threshold?: number;
  startFrames?: number;
  minSpeechFrames?: number;
  endFrames?: number;
  lookbackFrames?: number;
  maxFrames?: number;
  frameSize?: number;
  onClassifierFailure?: (error: unknown) => void;
  onSpeechStart?: () => void;
}): VadSegmenter;
export function createVadSpeechGate(options?: {
  classify?: (frame: Float32Array) => Awaitable<number>;
  frameSize?: number;
  threshold?: number;
  lookbackFrames?: number;
  hangFrames?: number;
  onClassifierFailure?: (error: unknown) => void;
}): {
  push(samples: ArrayLike<number>): Promise<Float32Array>;
  flush(): Float32Array;
  reset(): void;
};
export function createEchoGuard(options?: {
  compare?: (segment: Float32Array) => Awaitable<number>;
  threshold?: number;
  onFailure?: (error: unknown) => void;
  now?: () => number;
  tailMs?: number;
  minSamples?: number;
  windowSamples?: number;
  passGapMs?: number;
  /** Exact silence shorter than this many samples is part of the sound compared (default 1: every zero is left out). */
  silentRun?: number;
  /** 'silence': what is dropped comes back as silence of the same length, so a stream keeps its timing (default 'nothing'). */
  dropAs?: 'nothing' | 'silence';
  /** After a comparator failure, stop comparing: everything passes (default true). */
  latchOnFailure?: boolean;
}): {
  setPlaying(value: boolean): void;
  playbackSent(bytes: number, sampleRate: number): void;
  playbackInterrupted(): void;
  inspect(segment: Float32Array): Promise<{ segment: Float32Array | null; reason: string }>;
  filter(segment: Float32Array): Promise<Float32Array | null>;
  push(segment: Float32Array): Promise<{ segment: Float32Array | null; reason: string }>;
};
export function chainEchoGuards(...guards: Array<{
  filter(segment: Float32Array): Awaitable<Float32Array | null>;
  setPlaying?(value: boolean): void;
  playbackSent?(bytes: number, sampleRate: number): void;
  playbackInterrupted?(): void;
} | null | undefined>): {
  filter(segment: Float32Array): Promise<Float32Array | null>;
  setPlaying(value: boolean): void;
  playbackSent(bytes: number, sampleRate: number): void;
  playbackInterrupted(): void;
};

export function appendTrailingSilence(samples: Float32Array, sampleRate?: number, silenceMs?: number): Float32Array;
export function appendTrailingSilence(samples: Int16Array, sampleRate?: number, silenceMs?: number): Int16Array;
export function appendTrailingSilence(samples: Buffer, sampleRate?: number, silenceMs?: number): Buffer;
export function appendTrailingSilence(samples: Uint8Array, sampleRate?: number, silenceMs?: number): Float32Array;
export function confidenceFromLogProbabilities(logs?: number[]): number | null;
export interface DoubtfulOptions {
  language?: string;
  stockPhrases?: string[];
  stockPhrasesByLanguage?: Record<string, string[]>;
  minDurationSeconds?: number;
  minWordsPerSecond?: number;
  loopLength?: number;
  isNonWord?: (word: string) => boolean;
  nonWordRatio?: number;
  logprob?: number;
  logprobMin?: number;
  noSpeechProbability?: number;
  noSpeechMax?: number;
  expectedVocabulary?: string[] | string;
  vocabularyEchoMinWords?: number;
  vocabularyEchoRatio?: number;
  lowConfidence?: number;
}
export function analyzeTranscription(text: unknown, durationMs: number, options?: DoubtfulOptions): { doubtful: boolean; reason: string; confidence: number | null };
export function isDoubtfulTranscription(text: unknown, durationMs: number, options?: DoubtfulOptions): boolean;
export function createLocalTranscriber(options: {
  transcribe: (samples: Float32Array, options: object) => Awaitable<string | { text: string; confidence?: number | null; logprob?: number; noSpeechProbability?: number }>;
  sampleRate?: number;
  silenceMs?: number;
  inputFormat?: 'float32' | 'pcm16';
  doubtfulOptions?: DoubtfulOptions;
  lowConfidence?: number;
}): { transcribe(samples: ArrayLike<number> | Uint8Array, options?: { language?: string }): Promise<{ text: string; durationMs: number; doubtful: boolean; reason: string; confidence: number | null }> };
export function createTranscriptionProviderChain(options: {
  providers: Array<{ id?: string; transcribe(request: { audio: Uint8Array; language: string | null; requestedLanguage?: string | null; mediaType?: string }): Awaitable<string | { text: string; heardLanguage?: string | null }> }>;
  supportedLanguages?: string[];
}): { transcribe(audio: Uint8Array, options?: { language?: string; mediaType?: string }): Promise<{
  text: string;
  heardLanguage: string | null;
  provider: string;
  fallback: boolean;
  attempts: ProviderAttempt[];
}> };

export interface VoiceSession { role?: string; language?: string; requestedMode?: 'normal' | 'confidential'; allowCloudFallback?: boolean }
export interface ConfidentialDecision { mode: 'normal' | 'confidential'; cloudAudioAllowed: boolean; reason: string }
export function createConfidentialPolicy(options?: {
  defaultRoles?: string[];
  lockedRoles?: string[];
  cloudFallbackRoles?: string[];
  localUnsupportedLanguages?: string[];
  defaultMode?: 'normal' | 'confidential';
}): { decide(session?: VoiceSession): ConfidentialDecision; onLocalFailure(session?: VoiceSession): ConfidentialDecision };
export interface ConfidentialSessionState extends ConfidentialDecision { state: 'active' | 'ended'; doubts: number; failures: number }
export function createConfidentialSession(policy: ReturnType<typeof createConfidentialPolicy>, session?: VoiceSession, options?: {
  doubtLimit?: number;
  failureLimit?: number;
}): {
  snapshot(): ConfidentialSessionState;
  onAccepted(): ConfidentialSessionState;
  onDoubt(): ConfidentialSessionState;
  onLocalFailure(): ConfidentialSessionState;
  end(): ConfidentialSessionState;
};

export function createSpeechChunker(options?: { maxLength?: number; abbreviations?: string[] }): {
  push(chunk: unknown): string[];
  flush(): string[];
};
export interface SpokenTextOptions { ignoredWords?: string[]; minPrecision?: number; minCoverage?: number; minWords?: number; final?: boolean }
export function compareSpokenText(expected: unknown, spoken: unknown, options?: SpokenTextOptions): { precision: number; coverage: number };
export function hasSpeechDrift(expected: unknown, spoken: unknown, options?: SpokenTextOptions): boolean;
export function buildExpectedVocabulary(groups?: string[][], options?: { maxChars?: number }): string;

export function splitSpeechPieces(text: unknown, options?: { maxChars?: number }): string[];
export function createPieceVoiceService<T>(options: {
  providers: Array<{ id?: string; synthesize(request: { text: string; index: number; [key: string]: unknown }): Awaitable<T> }>;
  maxConcurrent?: number;
}): {
  synthesize(piecesOrText: string[] | string, request?: { maxChars?: number; [key: string]: unknown }): Promise<{
    pieces: T[];
    provider: string;
    fallback: boolean;
    attempts: ProviderAttempt[];
  }>;
};

export function createMicrophoneGate(options?: {
  vad?: Parameters<typeof createVadSpeechGate>[0] | { push(samples: Float32Array): Awaitable<Float32Array> } | null;
  echo?: Parameters<typeof createEchoGuard>[0] | { push(segment: Float32Array): Awaitable<{ segment: Float32Array | null }>; playbackSent?(bytes: number, sampleRate: number): void; playbackInterrupted?(): void } | null;
  now?: () => number;
}): {
  push(base64: string): Promise<string>;
  playbackSent(bytes: number, sampleRate: number): void;
  playbackInterrupted(): void;
};

export interface Utterance { text: string; confidence: number | null; audio: string; durationMs: number }
export function createUtteranceSegmenter(options: {
  transcribe: (samples: Float32Array) => Awaitable<string | { text: string; confidence?: number | null }>;
  sampleRate?: number;
  silenceMs?: number;
  minSpeechMs?: number;
  frameMs?: number;
  threshold?: number;
}): {
  push(base64: string): Promise<Utterance[]>;
  finish(): Promise<Utterance[]>;
};
