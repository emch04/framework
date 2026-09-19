/** The three async methods a keystore must have. expo-secure-store fits as-is. */
export interface Keystore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Anything with the browser Storage shape. */
export interface WebStorageLike {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createMemoryKeystore(): Keystore;
export function createWebKeystore(storage: WebStorageLike | null | undefined): Keystore;

export interface SessionTokens {
  accessToken?: string | null;
  refreshToken?: string | null;
}

export interface SecureSession {
  readonly keys: Readonly<{ access: string; refresh: string; biometric: string }>;
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  save(tokens?: SessionTokens): Promise<void>;
  clear(): Promise<void>;
  forget(): void;
}

export function createSecureSession(options: { keystore: Keystore; namespace?: string }): SecureSession;

/** expo-local-authentication's shape, narrowed to what the gate uses. */
export interface Authenticator {
  hasHardwareAsync(): Promise<boolean>;
  isEnrolledAsync(): Promise<boolean>;
  authenticateAsync(options?: { promptMessage?: string }): Promise<{ success: boolean }>;
}

export interface BiometricState {
  enabled: boolean;
  hardware: boolean;
  enrolled: boolean;
  supported: boolean;
}

export interface BiometricEnableResult {
  enabled: boolean;
  supported: boolean;
  failed: boolean;
}

export interface BiometricGate {
  readonly key: string;
  read(): Promise<BiometricState>;
  enable(options?: { promptMessage?: string }): Promise<BiometricEnableResult>;
  disable(): Promise<{ enabled: false }>;
  confirm(options?: { promptMessage?: string }): Promise<boolean>;
}

export function createBiometricGate(options: {
  keystore: Keystore;
  authenticator: Authenticator;
  namespace?: string;
  promptMessage?: string;
}): BiometricGate;

/**
 * 'native'   — the platform's own glass material (iOS glass effect API);
 * 'blur'     — a real backdrop blur, iOS AND Android;
 * 'fallback' — no blur available; an honest translucent layer.
 */
export type GlassMode = 'native' | 'blur' | 'fallback';

export function resolveGlassMode(facts?: {
  platform?: string;
  apiAvailable?: boolean;
  effectAvailable?: boolean;
  blurAvailable?: boolean;
}): GlassMode;

export interface BlurProps {
  intensity: number;
  tint: string;
  /** Android only, and required there: without it the blur is not a blur. */
  experimentalBlurMethod?: string;
}

export function blurPropsFor(platform: string, intensity?: number): BlurProps;

/* ─────────────────────────── Foreground watch ────────────────────────── */

export interface WatchedItem {
  createdAt?: string;
  read?: boolean;
  [key: string]: unknown;
}

export const FOREGROUND_POLL_MS: number;
export function freshItems<T extends WatchedItem>(items: T[] | null | undefined, lastSeenISO: string | null): T[];
export function nextStamp(items: WatchedItem[] | null | undefined, previous: string | null): string | null;
export function shouldPoll(appState: string, hasUser: boolean): boolean;

/* ───────────────────────────── Push policy ───────────────────────────── */

export type PushPermission = 'undetermined' | 'granted' | 'denied';
export type RegistrationAction = 'none' | 'register' | 'request' | 'open-settings';

export function decideRegistrationAction(input: {
  explicit: boolean;
  permission: PushPermission;
}): RegistrationAction;

export interface NotificationRoute {
  pattern: RegExp;
  allow?: (recipient: unknown, match: RegExpMatchArray) => boolean;
  to?: string;
}

export interface NotificationPayload {
  actionIdentifier?: string;
  route?: unknown;
  [key: string]: unknown;
}

export interface NotificationRouter {
  readonly fallback: string;
  resolve(route: unknown, recipient?: unknown): string;
  resolveAction(payload: NotificationPayload | null | undefined, recipient?: unknown): string;
}

export function createNotificationRouter(options: {
  fallback: string;
  routes?: NotificationRoute[];
  actions?: Record<string, (payload: NotificationPayload) => string | null | undefined>;
}): NotificationRouter;

/* ──────────────────────────── Push settings ──────────────────────────── */

export type PushState = 'enabled' | 'disabled' | 'undetermined' | 'denied' | 'error';
export type PushViewState = PushState | 'loading';
export type PushAction = 'enable' | 'disable' | 'open-settings' | 'retry';

export function resolvePushAction(state: PushViewState | string): PushAction | null;
export function isPushEnabled(state: PushViewState | string): boolean;

export interface PushSettingsSnapshot {
  state: PushViewState;
  busy: boolean;
}

export interface PushSettingsOperations {
  getState(): Promise<PushState>;
  enable?(): Promise<unknown>;
  disable?(): Promise<unknown>;
  openSettings?(): Promise<unknown>;
}

export interface PushSettingsController {
  activate(): { ready: Promise<void>; dispose(): void };
  refresh(): Promise<void>;
  act(): Promise<void>;
}

export function createPushSettingsController(
  operations: PushSettingsOperations,
  onChange: (snapshot: PushSettingsSnapshot) => void
): PushSettingsController;

/* ────────────────────────────── Checkout ─────────────────────────────── */

export interface LinkingLike {
  openURL(url: string): Promise<unknown>;
}

export interface WebBrowserLike {
  openAuthSessionAsync?(url: string, returnUrl: string): Promise<{ type: string }>;
  openBrowserAsync(url: string, options?: Record<string, unknown>): Promise<unknown>;
}

/** Resolves true when the person came back through the return link — never "paid". */
export type CheckoutOpener = (url: string, returnUrl?: string) => Promise<boolean>;

export function createCheckoutOpener(options: {
  linking: LinkingLike;
  loadBrowser?: () => WebBrowserLike | null;
  browserOptions?: Record<string, unknown>;
}): CheckoutOpener;

/* ─────────────────────────── Push registration ───────────────────────── */

export interface PushDeviceRecord {
  registered: boolean;
  enabled: boolean;
}

export interface PushRegistration {
  installationId: string;
  pushToken: string;
  platform: string;
  deviceName?: string;
}

export interface PushApi {
  register(registration: PushRegistration): Promise<PushDeviceRecord>;
  current(installationId: string): Promise<PushDeviceRecord>;
  unregister(installationId: string): Promise<unknown>;
}

export interface PushDependencies {
  platform: string;
  isDevice: boolean;
  deviceName?: string | null;
  randomUUID(): string;
  keystore: Keystore;
  projectId: string | (() => Promise<string> | string);
  notifications: Record<string, any>;
  channels?: Array<{ id: string; name: string; config?: Record<string, unknown> }>;
  categories?: Array<{ id: string; actions: unknown[] }>;
  router: NotificationRouter;
  navigate(route: string): void;
  onAction?(payload: NotificationPayload): boolean | Promise<boolean>;
  api: PushApi;
}

export interface PushService {
  getInstallationId(): Promise<string>;
  getState(): Promise<PushState | 'unsupported'>;
  enable(): Promise<PushState | 'unsupported'>;
  sync(): Promise<PushState | 'unsupported'>;
  disable(): Promise<PushState | 'unsupported'>;
  unregister(): Promise<void>;
  allowRegistration(): void;
  startListeners(recipient?: unknown): Promise<() => void>;
  logout(signOut?: () => Promise<void>): Promise<void>;
}

export function createPushService(options: {
  load: () => PushDependencies | Promise<PushDependencies>;
  namespace?: string;
}): PushService;

export function readPermission(
  status: { status?: string; granted?: boolean; ios?: { status: number } },
  notifications: { IosAuthorizationStatus?: Record<string, number> }
): PushPermission;

/* ───────────────────────────── API transport ─────────────────────────── */

export class ApiError extends Error {
  name: 'ApiError';
  status: number;
  /** A failure can still be actionable — a 409 may carry where to go next. */
  data?: unknown;
  constructor(message: string, status: number, data?: unknown);
}

export interface ApiClient {
  /** Unwraps the `data` envelope; throws ApiError on anything but 2xx. */
  request<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  /** Server-sent events: the checked response, unread. */
  stream(path: string, init?: RequestInit): Promise<Response>;
  /** Bytes: the checked response, for the caller to write to disk. */
  raw(path: string, init?: RequestInit): Promise<Response>;
  /** Relative paths resolve against the origin, not against /api. */
  resolveAssetUrl(path: string | null | undefined): string | undefined;
  ApiError: typeof ApiError;
}

export function createApiClient(options: {
  baseUrl: string;
  session: SecureSession;
  fetch?: typeof fetch;
  language?: () => string | null | undefined;
  platform?: string;
  refresh?: () => Promise<void>;
  excluded?: string[];
  loginPath?: string;
  refreshPath?: string;
  onSessionExpired?: (cause: unknown) => void;
}): ApiClient;

/* ───────────────────────────── Connectivity ──────────────────────────── */

/** What the OS reports, narrowed to what the rules read. NetInfo's state fits. */
export interface NetworkSnapshot {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
  type?: string | null;
}

export type Reachability = 'online' | 'offline' | 'unknown';
export type ConnectionLink = 'wifi' | 'cellular' | 'none' | 'unknown';
export type TransportFailure = 'timeout' | 'unreachable';

export const TRANSPORT_BLACKOUT_MS: number;

/** Offline ONLY without any interface. The OS "no Internet" stays unknown. */
export function readReachability(snapshot: NetworkSnapshot | null | undefined): Reachability;
export function readConnectionLink(snapshot: NetworkSnapshot | null | undefined): ConnectionLink;
export function isDefinitelyOffline(snapshot: NetworkSnapshot | null | undefined): boolean;
export function worthAttempting(snapshot: NetworkSnapshot | null | undefined): boolean;
export function hasComeBack(previous: Reachability, next: Reachability): boolean;
export function shouldDeclareTransportDown(input: { reason: TransportFailure; reachability: Reachability }): boolean;

/** @react-native-community/netinfo's default export, narrowed. */
export interface NetInfoLike {
  addEventListener(listener: (state: NetworkSnapshot) => void): (() => void) | { remove(): void };
  fetch(): Promise<NetworkSnapshot>;
}

export interface ConnectivityMonitor {
  start(): void;
  stop(): void;
  /** Re-reads the OS without emitting the comeback. Resolves worthAttempting. */
  refresh(): Promise<boolean>;
  setSnapshot(next: NetworkSnapshot | null | undefined): void;
  getReachability(): Reachability;
  getConnectionLink(): ConnectionLink;
  isTransportDown(): boolean;
  isOffline(): boolean;
  shouldAttemptRequest(): boolean;
  noteTransportFailure(reason?: TransportFailure): void;
  noteTransportSuccess(): void;
  setRecoveryProbe(probe: (() => Promise<unknown> | unknown) | null): void;
  /** Shaped for useSyncExternalStore. */
  subscribe(listener: () => void): () => void;
  onComeback(listener: () => void): () => void;
}

export function createConnectivityMonitor(options?: {
  netInfo?: NetInfoLike;
  blackoutMs?: number;
  now?: () => number;
}): ConnectivityMonitor;

/* ────────────────────────── Over-the-air updates ─────────────────────── */

export const UPDATE_CHECK_INTERVAL_MS: number;
export const UPDATE_APPLY_GRACE_MS: number;

export function shouldCheckForUpdate(
  context: { enabled: boolean; online: boolean; lastCheckAt: number | null; now: number },
  intervalMs?: number
): boolean;

export function shouldApplyUpdate(context: {
  downloaded: boolean;
  stillInBackground: boolean;
  pendingWrites: number;
}): boolean;

export function describeRelease(input: {
  version?: string | null;
  updateId?: string | null;
  isEmbeddedLaunch: boolean;
}): string;

/** expo-updates' module namespace, narrowed to what the watcher uses. */
export interface UpdatesLike {
  isEnabled: boolean;
  isEmbeddedLaunch: boolean;
  updateId?: string | null;
  channel?: string | null;
  runtimeVersion?: string | null;
  checkForUpdateAsync(): Promise<{ isAvailable: boolean }>;
  fetchUpdateAsync(): Promise<{ isNew: boolean }>;
  reloadAsync(): Promise<void>;
}

/** React Native's AppState, narrowed. */
export interface AppStateLike {
  currentState: string | null;
  addEventListener(event: 'change', listener: (state: string) => void): { remove(): void } | void;
}

export interface BuildDescription {
  updateId: string | null;
  channel: string | null;
  runtimeVersion: string | null;
  isEmbeddedLaunch: boolean;
  release: string;
}

export interface UpdateWatcher {
  start(): void;
  stop(): void;
  /** Resolves true when a new update was downloaded by this call. */
  check(now?: number): Promise<boolean>;
  hasPendingUpdate(): boolean;
  describeBuild(version?: string | null): BuildDescription;
}

export function createUpdateWatcher(options: {
  updates: UpdatesLike;
  appState: AppStateLike;
  isOnline?: () => boolean;
  pendingWrites?: () => number;
  onError?: (error: unknown, context: { where: 'checkForUpdate' | 'reloadAsync' }) => void;
  checkIntervalMs?: number;
  graceMs?: number;
  now?: () => number;
}): UpdateWatcher;

/* ────────────────────────────── Media cache ──────────────────────────── */

export const MEDIA_CACHE_MAX_FILES: number;
export const MEDIA_CACHE_MAX_BYTES: number;
export const MEDIA_CACHE_ABANDONED_MS: number;

/** [a-z0-9-] only. Every part that changes the bytes — a version included. */
export function contentKey(...parts: Array<string | number | null | undefined>): string;

export function extensionFor(
  contentType: string | null | undefined,
  types: Record<string, string>,
  fallback: string
): string;

export interface CachedFile {
  name: string;
  /** Bytes. */
  size: number;
  /** Milliseconds. */
  modifiedAt: number;
}

export function planEviction(
  files: CachedFile[],
  options: {
    extensions: string[];
    maxFiles?: number;
    maxBytes?: number;
    abandonedAfterMs?: number;
    now?: number;
  }
): string[];

/** expo-file-system/legacy's shape, narrowed. `modificationTime` in seconds. */
export interface FileSystemLike {
  getInfoAsync(uri: string): Promise<{ exists: boolean; isDirectory?: boolean; size?: number; modificationTime?: number }>;
  makeDirectoryAsync(uri: string, options?: { intermediates?: boolean }): Promise<void>;
  moveAsync(options: { from: string; to: string }): Promise<void>;
  deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<void>;
  readDirectoryAsync(uri: string): Promise<string[]>;
}

export type MediaWriter = (tempUri: string) => Promise<unknown>;

export interface MediaCache {
  readonly directory: string;
  lookup(key: string): Promise<string | null>;
  store(key: string, extension: string, write: MediaWriter): Promise<string>;
  resolve(key: string, download: () => Promise<{ extension: string; write: MediaWriter }>): Promise<string>;
  /** Resolves the names deleted. */
  tidy(): Promise<string[]>;
}

export function createMediaCache(options: {
  fs: FileSystemLike;
  directory: string;
  extensions: string[];
  maxFiles?: number;
  maxBytes?: number;
  abandonedAfterMs?: number;
  now?: () => number;
}): MediaCache;
