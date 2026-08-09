import type {
  AuthMiddlewareOptions,
  CsrfMiddlewareOptions,
  CspOptions,
  LoginLimiterOptions,
  RateLimitOptions,
  RevocationStore,
  SessionCookieOptions,
  WafOptions,
  WebauthnOptions,
  WebauthnStore
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
  [key: string]: unknown;
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
  extractToken?: AuthMiddlewareOptions['extractToken'];
  roles?: SaasRoles;
  publicUserFields?: string[];
  cookie?: SessionCookieOptions;
  csrf?: CsrfMiddlewareOptions;
  webauthnStore?: WebauthnStore;
  webauthn?: WebauthnOptions;
  waf?: WafOptions;
  csp?: CspOptions;
  apiRateLimit?: RateLimitOptions;
  loginRateLimit?: LoginLimiterOptions;
  [key: string]: unknown;
}

export function createSaasApp(options: CreateSaasAppOptions): SaasApp;
