export type Awaitable<T> = T | Promise<T>;

export const VOICE_VERSION: 'v2';
export const VOICE_FILTER: string;

export interface FfmpegOptions {
  filter?: string;
  channels?: number;
  sampleRate?: number;
  codec?: string;
  bitrate?: string;
}

export function buildFfmpegArgs(inputPath: string, outputPath: string, options?: FfmpegOptions): string[];

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
