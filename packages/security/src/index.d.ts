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
