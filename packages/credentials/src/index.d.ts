/*
 * Structural express types, declared here rather than pulled from @types/express:
 * a package that only hands back a router should not force a type dependency on
 * its consumers.
 */
export interface RequestLike {
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  user?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResponseLike {
  status(statusCode: number): { json(payload: unknown): unknown };
  [key: string]: unknown;
}

export type NextFunction = (error?: unknown) => unknown;
export type RequestHandler = (req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;

/** An express Router — opaque here, mount it with `app.use(path, router)`. */
export type Router = unknown;

export interface CredentialEntryInput {
  key: string;
  label?: string;
  /** Defaults to true. A public client id or sender address should be false. */
  secret?: boolean;
  help?: string;
  where?: string;
  placeholder?: string;
}

export interface CredentialSpaceInput {
  id: string;
  label?: string;
  hint?: string;
  keys: CredentialEntryInput[];
}

export interface CredentialEntry {
  key: string;
  label: string;
  secret: boolean;
  help: string | null;
  where: string | null;
  placeholder: string | null;
  space: string;
}

export interface CredentialSpace {
  id: string;
  label: string;
  hint: string | null;
  keys: CredentialEntry[];
}

export interface CredentialCatalog {
  spaces: CredentialSpace[];
  has(key: string): boolean;
  describe(key: string): CredentialEntry | null;
  isReserved(key: string): boolean;
  isSecret(key: string): boolean;
  keys(): string[];
}

export function createCredentialCatalog(options: {
  spaces: CredentialSpaceInput[];
  reservedKeys?: string[];
}): CredentialCatalog;

export type ValueClass = 'live' | 'test' | 'unknown';

export const LIVE: 'live';
export const TEST: 'test';
export const UNKNOWN: 'unknown';

export interface WritePermission {
  ok: boolean;
  reason?: string;
}

export interface ValueGuard {
  isGuarded(key: string): boolean;
  classify(value: unknown): ValueClass;
  mayRead(key: string, context?: { value?: unknown; decidingValue?: unknown }): boolean;
  mayWrite(key: string, value: unknown): WritePermission;
  restrictsHere(key: string): WritePermission;
  decidingKey: string | null;
  isProduction(): boolean;
}

export function createValueGuard(options?: {
  keys?: string[];
  decidingKey?: string;
  classify?: (value: unknown) => ValueClass;
  livePattern?: RegExp;
  testPattern?: RegExp;
  isProduction?: () => boolean;
  restrictedMessage?: string;
  env?: NodeJS.ProcessEnv;
}): ValueGuard;

export function createPermissiveGuard(): ValueGuard;

export interface CredentialRow {
  key: string;
  value: string;
  secret?: boolean;
  updatedAt?: Date | string | null;
  updatedBy?: string | null;
}

export interface CredentialStore {
  findAll(): Promise<CredentialRow[]>;
  upsert(row: CredentialRow): Promise<void>;
}

export interface ChallengeRecord {
  codeHash?: string | null;
  codeExpiresAt?: Date | string | null;
  attempts?: number;
  unlockedUntil?: Date | string | null;
  lastRequestedAt?: Date | string | null;
}

export interface ChallengeStore {
  find(subjectId: string | number): Promise<ChallengeRecord | null>;
  save(subjectId: string | number, record: ChallengeRecord): Promise<void>;
}

export function createMemoryCredentialStore(initialRows?: CredentialRow[]): CredentialStore;
export function createMemoryChallengeStore(): ChallengeStore;

export function createMongoCredentialStore(options: {
  collection: unknown;
  isReady?: () => boolean;
  maxTimeMS?: number;
}): CredentialStore;

export function createMongoChallengeStore(options: { collection: unknown }): ChallengeStore;

export interface FieldCipher {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

export interface CredentialStatusEntry {
  key: string;
  label: string;
  help: string | null;
  where: string | null;
  placeholder: string | null;
  secret: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
  configured: boolean;
  source: 'interface' | 'environment' | 'disconnected' | 'absent';
  preview: string | null;
  updatedAt: Date | string | null;
}

export interface CredentialStatus {
  spaces: Array<{
    id: string;
    label: string;
    hint: string | null;
    keys: CredentialStatusEntry[];
  }>;
}

export interface CredentialVault {
  get(key: string): Promise<string | null>;
  getMany(keys: string[]): Promise<Record<string, string | null>>;
  stored(): Promise<Map<string, string | null>>;
  set(key: string, value: unknown, meta?: { updatedBy?: string | null }): Promise<void>;
  disconnect(key: string, meta?: { updatedBy?: string | null }): Promise<void>;
  forget(): void;
  status(): Promise<CredentialStatus>;
  isRotating(): boolean;
  mask(value: string | null | undefined): string | null;
  DISCONNECTED: string;
}

export function createCredentialVault(options: {
  store: CredentialStore;
  catalog: CredentialCatalog;
  cipher: FieldCipher;
  /** The generation being retired, for the duration of a rotation. */
  previousCipher?: Pick<FieldCipher, 'decrypt'>;
  guard?: ValueGuard;
  env?: NodeJS.ProcessEnv;
  cacheMs?: number;
  now?: () => number;
  logger?: { warn?(message: string): void; error?(message: string): void };
  onChange?: (event: { key: string; action: 'set' | 'disconnect' }) => void | Promise<void>;
}): CredentialVault;

export const DISCONNECTED: string;

export interface HydrationResult {
  applied: number;
  removed: number;
  restored: number;
}

export interface EnvHydrator {
  hydrate(keys: string[]): Promise<HydrationResult>;
  startRefresh(
    keys: string[],
    options?: { intervalMs?: number; onChange?: (result: HydrationResult) => void }
  ): () => void;
  reset(): void;
}

export function createEnvHydrator(options: {
  vault: Pick<CredentialVault, 'stored'>;
  guard?: ValueGuard;
  env?: NodeJS.ProcessEnv;
  logger?: { warn?(message: string): void };
}): EnvHydrator;

export interface UnlockChallenge {
  requestCode(subjectId: string | number): Promise<Record<string, unknown> & { expiresInMs: number }>;
  verifyCode(subjectId: string | number, code: string): Promise<{ unlockedUntil: Date }>;
  unlockedUntil(subjectId: string | number): Promise<Date | null>;
  assertUnlocked(subjectId: string | number): Promise<void>;
  codeTtlMs: number;
  windowMs: number;
  maxAttempts: number;
  resendDelayMs: number;
}

export function createUnlockChallenge(options: {
  store: ChallengeStore;
  deliverCode: (payload: {
    subjectId: string | number;
    code: string;
    expiresInMs: number;
  }) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  codeTtlMs?: number;
  windowMs?: number;
  maxAttempts?: number;
  resendDelayMs?: number;
  now?: () => number;
}): UnlockChallenge;

export const DEFAULT_CODE_TTL_MS: number;
export const DEFAULT_WINDOW_MS: number;
export const DEFAULT_MAX_ATTEMPTS: number;
export const DEFAULT_RESEND_DELAY_MS: number;

export function createCredentialsRoutes(options: {
  vault: CredentialVault;
  authorize: RequestHandler;
  challenge?: UnlockChallenge | null;
  subjectOf?: (req: unknown) => string | number;
  logger?: { info?(message: string): void };
}): Router;

export interface RotationReport {
  apply: boolean;
  scanned: number;
  rotated: number;
  already: number;
  plain: number;
  skipped: number;
  unreadable: number;
  written: number;
  unreadableKeys: string[];
}

export interface RotationCompletion {
  complete: boolean;
  pending: number;
  unreadable: number;
  unreadableKeys: string[];
}

export type RotationDecision =
  | { status: 'rotated'; value: string }
  | { status: 'already' | 'plain' | 'skipped' | 'unreadable' };

export interface CredentialRotation {
  /** Read-only: what a rotation would do. Writes nothing. */
  plan(): Promise<RotationReport>;
  /** Rewrite every value the retiring cipher can still read. */
  apply(): Promise<RotationReport>;
  /** May the retiring cipher be dropped yet? */
  isComplete(): Promise<RotationCompletion>;
  decide(row: CredentialRow): RotationDecision;
}

export function createCredentialRotation(options: {
  store: CredentialStore;
  catalog: CredentialCatalog;
  to: FieldCipher;
  from: Pick<FieldCipher, 'decrypt'>;
  logger?: { warn?(message: string): void; error?(message: string): void };
}): CredentialRotation;

export function assertAdapter(adapter: unknown, methods: string[], name: string): void;
export function maskSecret(value: string | null | undefined): string | null;
export function maskEmail(email: string | null | undefined): string;

/* ─────────────────── Reading the state, for the screen ─────────────────── */

export type CredentialSource = 'interface' | 'serveur' | 'retiree' | 'absente';

export interface CredentialEntry {
  key: string;
  label: string;
  /** Doubt favours the secret: an unlabelled key comes back masked. */
  secret: boolean;
  placeholder: string | null;
  configured: boolean;
  source: CredentialSource;
  preview: string | null;
  help: string | null;
  where: string | null;
  readOnly: boolean;
  readOnlyReason: string | null;
}

export interface CredentialSpaceView {
  id: string;
  label: string;
  hint: string;
  keys: CredentialEntry[];
}

/** Reads the server answer without trusting its shape. */
export function readSpaces(payload: unknown): CredentialSpaceView[];
export function coverageOf(space: CredentialSpaceView | null | undefined): { done: number; total: number };
export function missingKeys(spaces: CredentialSpaceView[]): Array<CredentialEntry & { space: string }>;
export function firstSpaceToOpen(spaces: CredentialSpaceView[]): string | null;
/** Judged when it is read, never when it arrived. */
export function unlockState(raw: unknown, now?: number): { unlocked: boolean; minutesLeft: number };
export function cleanUnlockCode(input: unknown, length?: number): string;
