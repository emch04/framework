export interface RequestLike {
  body?: Record<string, unknown>;
  connection?: { remoteAddress?: string };
  cookies?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  ip?: string;
  path?: string;
  query?: Record<string, unknown>;
  user?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResponseLike {
  getHeader?(name: string): unknown;
  setHeader?(name: string, value: unknown): unknown;
  status(statusCode: number): {
    json(payload: unknown): unknown;
  };
}

export type NextFunction = (error?: unknown) => unknown;
export type RequestHandler = (req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;
export type Awaitable<T> = T | Promise<T>;

export interface CorsMiddlewareOptions {
  /** Explicit list of allowed origins (exact match on the Origin header). */
  allowedOrigins?: string[];
  /** Allow http(s)://127.0.0.1|localhost:* outside NODE_ENV=production. Default true. */
  allowDevOrigins?: boolean;
  /** Sets Access-Control-Allow-Credentials: true. Default true (matches cookie-based sessions). */
  credentials?: boolean;
  allowedHeaders?: string;
  allowedMethods?: string;
}

/**
 * Astratra has no fixed opinion on which origins to allow — that's
 * project-specific — but leaves this primitive available rather than
 * making every consumer hand-roll it. Mount first, ahead of every other
 * middleware, so CORS headers apply to the preflight OPTIONS response too.
 */
export function createCorsMiddleware(options?: CorsMiddlewareOptions): RequestHandler;

export interface SecurityHeadersOptions {
  /** X-Frame-Options value, or false to omit. Defaults to "DENY". */
  frameOptions?: string | false;
  /** Sets X-Content-Type-Options: nosniff. Defaults to true. */
  contentTypeOptions?: boolean;
  /** Referrer-Policy value, or false to omit. Defaults to "strict-origin-when-cross-origin". */
  referrerPolicy?: string | false;
  /** Permissions-Policy value, or false to omit. Defaults to a minimal deny-list (geolocation, camera, microphone, payment). */
  permissionsPolicy?: string | false;
  /** Strict-Transport-Security: true/false, or { maxAge, includeSubDomains } to customize. Defaults to true only when NODE_ENV=production (HSTS on plain HTTP dev breaks things). */
  hsts?: boolean | { maxAge?: number; includeSubDomains?: boolean };
}

/**
 * The standard header-hardening set beyond CSP: clickjacking (X-Frame-Options),
 * MIME sniffing (X-Content-Type-Options), referrer leakage (Referrer-Policy),
 * browser feature access (Permissions-Policy), and HTTP downgrade (HSTS).
 * Every option has a safe universal default, so createSaasApp mounts this
 * unconditionally.
 */
export function createSecurityHeadersMiddleware(options?: SecurityHeadersOptions): RequestHandler;

export interface SecurityEvent {
  status: number;
  method: string;
  path: string;
  ip: string | undefined;
  requestId: string | undefined;
  timestamp: string;
}

export interface SecurityAuditLoggerOptions {
  /** Response status codes that trigger a log line. Defaults to [401, 403, 429]. */
  statusCodes?: number[];
  /** Custom sink, e.g. (message, event) => yourLogger.warn(message, event). Defaults to @astratra/core's createLogger('astratra-security-audit').warn. */
  log?: (message: string, event: SecurityEvent) => void;
}

/**
 * Logs a structured event for any request whose response lands on one of
 * statusCodes (401/403/429 by default) — auth failures, CSRF/WAF blocks,
 * and rate limiting all end up here without each layer needing its own
 * logging call, since this observes the response rather than the
 * middleware that produced it.
 */
export function createSecurityAuditLogger(options?: SecurityAuditLoggerOptions): RequestHandler;

export interface PasswordHashOptions {
  /** scrypt cost factor (N), must be a power of 2. Defaults to 16384. */
  cost?: number;
  /** scrypt block size (r). Defaults to 8. */
  blockSize?: number;
  /** scrypt parallelization (p). Defaults to 1. */
  parallelization?: number;
}

/** Hashes a password with scrypt (Node built-in, no bcrypt/argon2 dependency). The salt and cost factor travel with the returned string. */
export function hashPassword(password: string, options?: PasswordHashOptions): Promise<string>;
/** Verifies a password against a hash from hashPassword(). Constant-time; returns false (never throws) for a wrong password or a malformed/foreign hash. */
export function verifyPasswordHash(password: string, hash: string): Promise<boolean>;

export interface FieldCipherOptions {
  /** A 32-byte AES-256 key, as a Buffer or a base64/hex-encoded string. */
  key: Buffer | string;
}

export interface FieldCipher {
  /** Encrypts a value (AES-256-GCM) into a single opaque string, safe to store in any field/column. */
  encrypt(plaintext: string | number): string;
  /** Decrypts a value produced by encrypt(). Throws if the key is wrong or the payload was tampered with. */
  decrypt(payload: string): string;
}

/**
 * Field-level encryption for values written to a store you control — Astratra
 * doesn't sit between your app and your database, so nothing upstream
 * encrypts data for you. Generate a key with generateFieldEncryptionKey()
 * once and keep it as a secret; rotating it makes old ciphertexts
 * undecryptable.
 */
export function createFieldCipher(options: FieldCipherOptions): FieldCipher;
export function generateFieldEncryptionKey(): string;

export interface AuthMiddlewareOptions<TDecoded = Record<string, unknown>> {
  secret: string;
  legacySecret?: string;
  algorithms?: string[];
  issuer?: string;
  audience?: string | string[];
  clockTolerance?: number;
  maxAge?: string | number;
  message?: unknown;
  extractToken?: (req: RequestLike) => string | null | undefined;
  verifySession?: (decoded: TDecoded) => Awaitable<boolean>;
  revocationStore?: RevocationStore;
}

export function createAuthMiddleware<TDecoded = Record<string, unknown>>(options: AuthMiddlewareOptions<TDecoded>): RequestHandler;
export function authorizeRoles(...roles: string[]): RequestHandler;

/**
 * Thrown by the default token extractor — and passed to `next(error)`,
 * never swallowed into a 401 — when `req.cookies` is `undefined` (no
 * cookie parser mounted) and no token was found by any other means either.
 */
export class AuthConfigurationError extends Error {}

export interface RevocationStore {
  revoke(jti: string, expiresAt: number): Awaitable<void>;
  isRevoked(jti?: string): Awaitable<boolean>;
  revokeAllForUser?(userId: string, revokedBeforeMs: number): Awaitable<void>;
  isRevokedForUser?(userId: string, issuedAtSeconds: number): Awaitable<boolean>;
}

export function createMemoryRevocationStore(): RevocationStore;

export interface SessionCookieOptions {
  name?: string;
  sameSite?: 'lax' | 'strict' | 'none' | string;
  secure?: boolean;
  path?: string;
  domain?: string;
  maxAgeMs?: number;
}

export const DEFAULT_SESSION_COOKIE_NAME: string;
export function parseCookieHeader(header?: string): Record<string, string>;
export function cookieParserMiddleware(): RequestHandler;
export function setSessionCookie(res: ResponseLike, token: string, options?: SessionCookieOptions): unknown;
export function clearSessionCookie(res: ResponseLike, options?: SessionCookieOptions): unknown;

export interface CsrfMiddlewareOptions {
  name?: string;
  headerName?: string;
  sameSite?: 'lax' | 'strict' | 'none' | string;
  secure?: boolean;
  path?: string;
  domain?: string;
  skip?: (req: RequestLike) => boolean;
}

export function createCsrfMiddleware(options?: CsrfMiddlewareOptions): RequestHandler;

/**
 * Issues the CSRF cookie on safe requests (GET/HEAD/OPTIONS) without ever
 * validating a token. Mount once, globally, ahead of all routes so the
 * double-submit cookie exists before a client's first mutating request —
 * see createCsrfMiddleware's README section on double-submit CSRF.
 */
export function createCsrfCookiePrimer(options?: Pick<CsrfMiddlewareOptions, 'name' | 'sameSite' | 'secure' | 'path' | 'domain' | 'skip'>): RequestHandler;

export interface RateLimitStore {
  init?(options: unknown): unknown;
  increment?(...args: unknown[]): unknown;
  decrement?(...args: unknown[]): unknown;
  resetKey?(...args: unknown[]): unknown;
  resetAll?(...args: unknown[]): unknown;
  get?(...args: unknown[]): unknown;
  shutdown?(...args: unknown[]): unknown;
}

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  skip?: (req: RequestLike) => boolean | Promise<boolean>;
  standardHeaders?: boolean | string;
  legacyHeaders?: boolean;
  validate?: Record<string, unknown> | boolean;
  message?: unknown;
  store?: RateLimitStore;
  redisUrl?: string;
}

export interface LoginBlockedContext {
  ip: string;
  req: RequestLike;
}

export interface AccountBlockedContext extends LoginBlockedContext {
  identifier: unknown;
}

export interface LoginLimiterOptions extends RateLimitOptions {
  onBlocked?: (context: LoginBlockedContext) => Awaitable<void>;
}

export interface AccountLimiterOptions extends RateLimitOptions {
  keyGenerator?: (req: RequestLike) => string;
  onBlocked?: (context: AccountBlockedContext) => Awaitable<void>;
}

export function createApiLimiter(options?: RateLimitOptions): RequestHandler;
export function createLoginLimiter(options?: LoginLimiterOptions): RequestHandler;
export function createAccountLimiter(options?: AccountLimiterOptions): RequestHandler;
export function skipLocalhost(req: RequestLike): boolean;

export interface WafOptions {
  message?: unknown;
  patterns?: RegExp[];
}

export function createWafMiddleware(options?: WafOptions): RequestHandler;

export type CspDirectives = Record<string, string[]>;

export interface CspOptions {
  directives?: CspDirectives;
  reportOnly?: boolean;
}

export function createCspMiddleware(options?: CspOptions): RequestHandler;
export const DEFAULT_CSP_DIRECTIVES: CspDirectives;
export const WAF_PATTERNS: RegExp[];

export const CHALLENGE_TTL_MS: number;
export const RECOVERY_CODE_COUNT: number;

export interface WebauthnOptions {
  allowedOrigins?: string | string[];
  challengeTtlMs?: number;
  clientUrl?: string;
  recoveryCodeCount?: number;
  recoveryCodeSecret?: string;
  rpName?: string;
}

export interface WebauthnCredential {
  id?: string;
  credentialID?: string;
  publicKey: string | Uint8Array;
  counter: number;
  transports?: string[];
  deviceName?: string;
  [key: string]: unknown;
}

export interface WebauthnCredentialToSave {
  credentialID: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceName: string;
}

export type WebauthnChallengeType = 'registration' | 'authentication';

export interface WebauthnChallengeMetadata {
  rpID: string;
  origin: string;
  expiresAt: Date;
}

export interface WebauthnPendingChallenge {
  challenge: string;
  origin?: string;
  rpID?: string;
  metadata?: Partial<WebauthnChallengeMetadata>;
}

export interface WebauthnStore {
  getCredentialsForUser(userId: string): Awaitable<WebauthnCredential[]>;
  saveCredential(userId: string, credential: WebauthnCredentialToSave): Awaitable<void>;
  getCredentialById(credentialId: string): Awaitable<WebauthnCredential | null | undefined>;
  updateCredentialCounter(credentialId: string, counter: number): Awaitable<void>;
  saveChallenge(userId: string, challenge: string, type: WebauthnChallengeType, metadata: WebauthnChallengeMetadata): Awaitable<void>;
  consumeChallenge(userId: string, type: WebauthnChallengeType): Awaitable<WebauthnPendingChallenge | null | undefined>;
  saveRecoveryCodes?(userId: string, hashes: string[]): Awaitable<void>;
  consumeRecoveryCode?(userId: string, hash: string): Awaitable<boolean>;
}

export interface RpConfig {
  rpName: string;
  rpID: string;
  origin: string;
}

export interface WebauthnService {
  getRegistrationOptions(req: RequestLike, userId: string, userName: string): Promise<unknown>;
  verifyRegistration(userId: string, response: unknown, deviceName?: string): Promise<{
    verified: true;
    isFirstDevice: boolean;
    recoveryCodes: string[] | null;
  }>;
  getAuthenticationOptions(req: RequestLike, userId: string): Promise<unknown>;
  verifyAuthentication(userId: string, response: { id: string; [key: string]: unknown }): Promise<true>;
  hasCredentials(userId: string): Promise<boolean>;
  generateRecoveryCodes(userId: string): Promise<string[]>;
  verifyRecoveryCode(userId: string, code: string): Promise<boolean>;
  hashRecoveryCode(code: string): string;
  rpConfigForRequest(req: RequestLike): RpConfig;
}

export function createWebauthnService(store: WebauthnStore, options?: WebauthnOptions): WebauthnService;
export function rpConfigForRequest(req: RequestLike, options?: WebauthnOptions): RpConfig;
export function hashRecoveryCode(code: string, secret: string): string;

/**
 * Reference in-memory WebauthnStore implementation. Fine for local dev and
 * tests — credentials are lost on restart, so this is not a production
 * credential store.
 */
export function createMemoryWebauthnStore(): WebauthnStore;
