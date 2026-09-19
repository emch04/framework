/* ───────────────────────────── Versions ───────────────────────────── */

export type Platform = 'ios' | 'android';

export interface ParsedVersion {
  numbers: number[];
  prerelease: string[];
}

export function parseVersion(raw: unknown): ParsedVersion | null;
/** -1, 0 or 1; null when either side is unreadable. Numeric, never textual. */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null;
/** Server side: missing version counts as behind, unreadable does not. */
export function isBehind(installed: unknown, latest: unknown): boolean;
/** https://, itms-apps:// or market:// only. */
export function isValidStoreLink(link: unknown): link is string;

/* ───────────────────────────── Manifest ───────────────────────────── */

export interface PlatformVersions {
  latest: string;
  minimum?: string | null;
  storeUrl?: string | null;
}

export type VersionConfig = Partial<Record<Platform, PlatformVersions>>;

export interface ResolvedPlatformVersions {
  readonly latest: string;
  readonly minimum: string | null;
  readonly storeUrl: string | null;
}

export type VersionManifest = Readonly<Partial<Record<Platform, ResolvedPlatformVersions>>>;

export const PLATFORMS: readonly Platform[];
export const DEFAULT_MAX_AGE_SECONDS: number;

/** Validates at boot; throws TypeError on an unreadable version or a foreign link. */
export function defineVersionManifest(config: VersionConfig): VersionManifest;

export interface VersionResponse<T = VersionManifest> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

export function createVersionHandler<T = VersionManifest>(options: {
  versions: T | (() => T);
  maxAgeSeconds?: number;
}): () => VersionResponse<T>;

export interface ExpressLikeResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

export function toExpressHandler<T>(
  handler: () => VersionResponse<T>,
  options?: { wrap?: (body: T) => unknown }
): (req: unknown, res: ExpressLikeResponse) => unknown;

/* ─────────────────────────── Announcement ─────────────────────────── */

export interface DaytimeWindow {
  /** UTC hour, inclusive. */
  startHour: number;
  /** UTC hour, exclusive. */
  endHour: number;
}

export const DEFAULT_WINDOW: Readonly<DaytimeWindow>;
export const DEFAULT_BATCH_SIZE: number;
export const DEFAULT_ENV_VARIABLE: string;

/** Strictly env[variable] === '1'. */
export function isAnnouncementEnabled(env?: Record<string, string | undefined> | null, variable?: string): boolean;
export function isWithinDaytime(now: Date, window?: DaytimeWindow): boolean;
export function announcementId(platform: string, version: string): string;

export interface AnnouncementClaim {
  id: string;
  platform: string;
  version: string;
}

export interface AnnouncementOutcome {
  sent: number;
  failed: number;
  finishedAt: Date;
}

export interface AnnouncementStore {
  /** Atomic: true if newly claimed, false if this id was already claimed. */
  claim(claim: AnnouncementClaim): Promise<boolean>;
  complete(id: string, outcome: AnnouncementOutcome): Promise<void>;
}

export interface AnnouncementRecord extends AnnouncementClaim {
  sent: number;
  failed: number;
  finishedAt: Date | null;
}

export interface MemoryAnnouncementStore extends AnnouncementStore {
  get(id: string): Promise<AnnouncementRecord | null>;
}

export function createMemoryAnnouncementStore(): MemoryAnnouncementStore;

export interface AnnouncedDevice {
  id: string;
  appVersion?: string | null;
  language?: string | null;
}

export interface AnnouncementText {
  title: string;
  body: string;
}

export interface AnnouncementParams {
  version: string;
  platform: string;
}

export type MessageTemplate = string | ((params: AnnouncementParams) => string);

export type MessageCatalog = Record<string, { title: MessageTemplate; body: MessageTemplate }>;

export type AnnouncementMessage<P extends object = Record<string, unknown>> = P & AnnouncementText & {
  version: string;
  platform: string;
  language: string;
};

export interface SendResult {
  sent: number;
  failed: number;
}

export interface AnnouncementResult {
  platform: string;
  version: string;
  sent: number;
  failed: number;
}

export interface VersionAnnouncer {
  /** Announces what was not announced yet. Returns [] when off or at night. */
  run(): Promise<AnnouncementResult[]>;
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export function createVersionAnnouncer<D extends AnnouncedDevice = AnnouncedDevice, P extends object = Record<string, unknown>>(options: {
  versions: VersionConfig | VersionManifest | (() => VersionConfig | VersionManifest);
  store: AnnouncementStore;
  listDevices(platform: string): Promise<D[]>;
  send(devices: D[], message: AnnouncementMessage<P>): Promise<SendResult>;
  languagesFor?(devices: D[]): Promise<Map<string, string> | Record<string, string>>;
  messages?: MessageCatalog;
  translate?(language: string, params: AnnouncementParams): AnnouncementText | null | undefined;
  defaultLanguage?: string;
  /** Extra fields for every push, e.g. { category, route }. */
  payload?: P;
  /** Defaults to false. Pass a function to re-read the switch on every run. */
  enabled?: boolean | (() => boolean);
  window?: DaytimeWindow;
  batchSize?: number;
  platforms?: readonly string[];
  now?: () => Date;
  logger?: Logger | null;
}): VersionAnnouncer;

export type JobLock = <T>(name: string, ttlMs: number, fn: () => Promise<T>) => Promise<T | undefined>;

export interface AnnouncementSchedule {
  tick(): Promise<unknown>;
  stop(): void;
}

export function startAnnouncementSchedule(options: {
  announcer: VersionAnnouncer;
  intervalMs?: number;
  lock?: JobLock | null;
  lockName?: string;
  onError?: (error: unknown) => void;
  timers?: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: any): void;
  };
}): AnnouncementSchedule;

/* ───────────────────────────── Client ─────────────────────────────── */

export type VersionStatus = 'up_to_date' | 'available' | 'required' | 'unknown';

export interface StoreInfo {
  latest: string;
  minimum: string | null;
  storeUrl: string | null;
}

export const STORE_CHECK_INTERVAL_MS: number;

export function versionStatus(installed: unknown, info: StoreInfo | null | undefined): VersionStatus;
export function isBannerVisible(status: VersionStatus, latest: string | null | undefined, dismissedVersion: unknown): boolean;
export function shouldCheckStore(context: {
  lastCheck: number | null | undefined;
  now: number;
  online: boolean;
  force?: boolean;
  intervalMs?: number;
}): boolean;
export function infoForPlatform(data: unknown, platform: string): StoreInfo | null;

export interface StoreCopy {
  data: unknown;
  receivedAt: number;
}

export function readStoreCopy(raw: string | null | undefined): StoreCopy | null;

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
}

export interface StoreVersionSnapshot {
  status: VersionStatus;
  installed: string | null;
  info: StoreInfo | null;
  /** The "new version available" banner should show. */
  banner: boolean;
}

export interface StoreVersionWatcher {
  start(): Promise<void>;
  stop(): void;
  check(options?: { force?: boolean }): Promise<void>;
  dismiss(version: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): StoreVersionSnapshot;
}

export function createStoreVersionWatcher(options: {
  fetchVersions(): Promise<unknown>;
  storage: AsyncStorageLike;
  installedVersion(): string | null | undefined;
  platform: string;
  isOnline?: () => boolean;
  now?: () => number;
  onForeground?: ((listener: () => void) => (() => void) | { remove(): void } | void) | null;
  namespace?: string;
  intervalMs?: number;
}): StoreVersionWatcher;
