import type {
  AuthMiddlewareOptions,
  CorsMiddlewareOptions,
  CsrfMiddlewareOptions,
  CspOptions,
  LoginLimiterOptions,
  MongoSanitizeOptions,
  RateLimitOptions,
  RequestHandler,
  RevocationStore,
  SecurityAuditLoggerOptions,
  SecurityHeadersOptions,
  SessionCookieOptions,
  WafOptions,
  WebauthnOptions,
  WebauthnStore,
  RefreshTokenService,
  RefreshTokenStore
} from '@astratra/security';

export type Awaitable<T> = T | Promise<T>;

export interface SaasUser {
  id?: string;
  email?: string;
  role?: string;
  password?: string;
  passwordHash?: string;
  [key: string]: unknown;
}

export interface UserListOptions {
  role?: string;
  limit?: number;
  offset?: number;
}

export interface UsersStore {
  findByEmail(email: string): Awaitable<SaasUser | null>;
  findById(id: string): Awaitable<SaasUser | null>;
  create(userData: SaasUser): Awaitable<SaasUser>;
  list(options?: UserListOptions): Awaitable<SaasUser[]>;
  count?(options?: Pick<UserListOptions, 'role'>): Awaitable<number>;
  countByRole?(): Awaitable<Record<string, number>>;
  update(id: string, patch: Partial<SaasUser>): Awaitable<SaasUser | null>;
}

export interface MemoryUsersStoreOptions {
  users?: SaasUser[];
}

export function createMemoryUsersStore(options?: MemoryUsersStoreOptions): UsersStore;

export interface SettingsStore {
  get(key: string): Awaitable<unknown | null>;
  set(key: string, value: unknown): Awaitable<unknown>;
  getAll(): Awaitable<Record<string, unknown>>;
}

export function createMemorySettingsStore(initialSettings?: Record<string, unknown>): SettingsStore;

export interface NotificationPayload {
  title: string;
  message: string;
  channel?: unknown;
}

export interface SaasRoles {
  adminRoles?: string[];
  [key: string]: unknown;
}

export interface SaasApp {
  use(...handlers: unknown[]): SaasApp;
  listen?(...args: unknown[]): unknown;
  /** The exact auth middleware instance used by every built-in route — reuse it for your own routes instead of rebuilding a duplicate. */
  authMiddleware: RequestHandler;
  /** The exact CSRF middleware instance used by every built-in mutating route. */
  csrfMiddleware: RequestHandler;
  /** authorizeRoles(...options.roles.adminRoles) — the exact admin-role guard used internally. */
  authorizeAdmin: RequestHandler;
  [key: string]: unknown;
}

export interface ExtendRoutesContext {
  authMiddleware: RequestHandler;
  csrfMiddleware: RequestHandler;
  authorizeAdmin: RequestHandler;
  authorizeRoles: (...roles: string[]) => RequestHandler;
}

export interface CreateSaasAppOptions {
  jwtSecret?: string;
  legacyJwtSecret?: string;
  jwtExpiresIn?: string | number;
  jwtAlgorithms?: string[];
  jwtIssuer?: string;
  jwtAudience?: string | string[];
  usersStore?: UsersStore;
  settingsStore?: SettingsStore;
  notify: (userId: string, notification: NotificationPayload) => Awaitable<unknown>;
  verifyPassword: (user: SaasUser, password: string) => Awaitable<boolean>;
  verifySession?: AuthMiddlewareOptions['verifySession'];
  revocationStore?: RevocationStore;
  /** Phones registered for push. Defaults to an in-memory adapter. */
  devicesStore?: DevicesStore;
  /**
   * Long-lived renewal. OFF unless enabled: a refresh token is handed out
   * because a product needs it, never because a default said so.
   */
  refreshTokens?: {
    enabled?: boolean;
    ttlMs?: number;
    store?: RefreshTokenStore;
    service?: RefreshTokenService;
  };
  /**
   * Password reset. The routes exist only when `send` is provided — mounting
   * them without a transport would accept requests that go nowhere.
   * Requires `hashPassword`.
   */
  passwordReset?: {
    send(payload: { user: Record<string, unknown>; token: string }): Promise<unknown>;
    ttlMs?: number;
    store?: PasswordResetStore;
  };
  /** Required alongside passwordReset.send. */
  hashPassword?: (password: string) => Promise<string> | string;
  extractToken?: AuthMiddlewareOptions['extractToken'];
  roles?: SaasRoles;
  publicUserFields?: string[];
  cookie?: SessionCookieOptions;
  csrf?: CsrfMiddlewareOptions;
  /**
   * Mounts createCorsMiddleware as the FIRST middleware, ahead of
   * everything else — required for CORS headers to reach the preflight
   * OPTIONS response. `true` uses the default (dev origins only, no
   * explicit allow-list). Omit entirely for no CORS handling (unchanged
   * default behavior).
   */
  cors?: CorsMiddlewareOptions | true;
  /**
   * Forwarded to Express's `app.set('trust proxy', value)`. Unset by
   * default (Express trusts nothing beyond the direct socket) — set this
   * explicitly when the app runs behind a reverse proxy (nginx, an ALB...),
   * otherwise every client shares the same rate-limit bucket (the proxy's
   * own IP) instead of one bucket per real visitor. `1` trusts exactly one
   * hop; see Express's `trust proxy` docs for other topologies.
   */
  trustProxy?: boolean | number | string | string[];
  /** X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS. Every option has a safe default; mounted unconditionally like csp. */
  securityHeaders?: SecurityHeadersOptions;
  /**
   * Strips `$`-prefixed/dotted keys from req.body/req.query/req.params
   * before any route (built-in or via extendRoutes) can see them — closes
   * Mongo operator injection by default. Every option has a safe universal
   * default; mounted unconditionally like csp/securityHeaders. Pass `false`
   * to disable.
   */
  mongoSanitize?: MongoSanitizeOptions | boolean;
  /**
   * Structured logging for any request ending in 401/403/429 (failed auth,
   * CSRF/WAF block, rate limit). Mounted by default — pass `false` to
   * disable, `true` or an options object to customize (custom `log` sink,
   * different `statusCodes`).
   */
  securityAudit?: SecurityAuditLoggerOptions | boolean;
  webauthnStore?: WebauthnStore;
  webauthn?: WebauthnOptions;
  waf?: WafOptions;
  csp?: CspOptions;
  apiRateLimit?: RateLimitOptions;
  loginRateLimit?: LoginLimiterOptions;
  /**
   * Register your own routes here, not on the returned app after the fact.
   * createSaasApp() ends its own middleware stack with a catch-all 404 +
   * error handler; anything added to the returned app afterward is
   * unreachable. extendRoutes(app, ctx) runs before that catch-all, with
   * the same authMiddleware/csrfMiddleware instances the built-in routes use.
   */
  extendRoutes?: (app: SaasApp, ctx: ExtendRoutesContext) => void;
  [key: string]: unknown;
}

export function createSaasApp(options: CreateSaasAppOptions): SaasApp;

/* ───────────────── Devices and password resets ───────────────── */

export interface RegisteredDevice {
  installationId: string;
  pushToken: string;
  platform?: string;
  deviceName?: string;
  userId: string;
  enabled?: boolean;
  updatedAt?: number;
}

export interface DevicesStore {
  /** Keyed on the installation id: a re-registration updates, never duplicates. */
  upsert(device: RegisteredDevice): Promise<RegisteredDevice>;
  find(installationId: string): Promise<RegisteredDevice | null>;
  listForUser(userId: string): Promise<RegisteredDevice[]>;
  remove(installationId: string): Promise<unknown>;
}

export interface PasswordResetRecord {
  /** SHA-256 of the token. The token itself is never stored. */
  hash: string;
  userId: string;
  expiresAt: number;
}

export interface PasswordResetStore {
  save(record: PasswordResetRecord): Promise<unknown>;
  find(hash: string): Promise<PasswordResetRecord | null>;
  /** Single use: consuming deletes, so a replay finds nothing. */
  consume(hash: string): Promise<PasswordResetRecord | null>;
  deleteForUser(userId: string): Promise<unknown>;
}

export function createMemoryDevicesStore(): DevicesStore;
export function createMemoryPasswordResetStore(): PasswordResetStore;
