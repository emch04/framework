/* ───────────────── Session, routes and passwords ───────────────── */

export type Awaitable<T> = T | Promise<T>;

export class SessionExpiredError extends Error {
  code: 'SESSION_EXPIRED';
  cause: unknown | null;
}

export interface SessionClient<Response = unknown, Init = unknown> {
  /** Make a request; on an auth failure, refresh (single-flight) and replay ONCE. */
  call(path: string, init?: Init): Promise<Response>;
  /** The shared refresh — everyone racing a 401 awaits the same promise. */
  refreshOnce(): Promise<void>;
  SessionExpiredError: typeof SessionExpiredError;
}

export function createSessionClient<Response = unknown, Init = unknown>(options: {
  /** Yours: axios, fetch… Must reject with an error carrying `status` on HTTP failure. */
  request: (path: string, init?: Init) => Awaitable<Response>;
  /** Renews the session; must throw when it cannot. */
  refresh: () => Awaitable<void>;
  /** Paths that never trigger a refresh — the refresh and login endpoints belong here. */
  excluded?: string[];
  /** Called once per definitive expiry: clear storage, route to the login screen. */
  onSessionExpired?: (cause: unknown) => void;
  /** Default: error.status === 401. */
  isAuthError?: (error: unknown) => boolean;
}): SessionClient<Response, Init>;

export interface RouteGuard {
  isPublicRoute(route: readonly string[] | string | null | undefined): boolean;
  /** While the session restores, nothing is decided — no redirect on the transient state. */
  shouldRedirectToLogin(state: {
    isLoading?: boolean;
    isAuthenticated?: boolean;
    route?: readonly string[] | string | null;
  }): boolean;
  loginRoute: string;
  publicSegments: string[];
}

export function createRouteGuard(options: {
  /** The list names what is PUBLIC — everything else is closed. */
  publicSegments: string[];
  loginRoute?: string;
  /** What the bare root is. Default true: a splash screen decides for itself. */
  emptyIsPublic?: boolean;
}): RouteGuard;

export interface PasswordCheck {
  /** A translation key, not a sentence — the rule carries no language. */
  key: string;
  met: boolean;
}

export interface PasswordRules {
  /** Every condition separately — for ticking them off as the person types. */
  check(password: unknown): PasswordCheck[];
  isValid(password: unknown): boolean;
  /** Share of conditions met, 0..1 — feeds a progress bar. */
  strength(password: unknown): number;
  canSubmit(password: unknown, confirmation: unknown): boolean;
  minLength: number;
  keys: string[];
}

export function createPasswordRules(options?: {
  minLength?: number;
  conditions?: Array<{ key: string; test: (value: string, context: { minLength: number }) => boolean }>;
}): PasswordRules;

/* ─────────────────────── Offline queue ─────────────────────── */

export interface QueuedAction {
  id: number | string;
  type: string;
  payload: unknown;
  queuedAt: string;
  [key: string]: unknown;
}

export interface QueueStore {
  append(action: Omit<QueuedAction, 'id'>): Awaitable<QueuedAction>;
  /** Oldest first — order is the whole point. */
  list(): Awaitable<QueuedAction[]>;
  remove(id: number | string): Awaitable<void>;
}

export function createMemoryQueueStore(): QueueStore & { size(): number };

export interface ReplayReport {
  applied: number;
  rejected: number;
  /** True when an outage stopped the replay — same place next time. */
  halted: boolean;
  remaining: number;
  error: string | null;
}

export interface OfflineQueue {
  /** Record a mutation for later. Refused now if no handler could ever replay it. */
  enqueue(type: string, payload: unknown): Promise<QueuedAction>;
  /** Replay in order. Concurrent calls share one run. */
  replay(): Promise<ReplayReport>;
  /** What waits — for a badge in the interface. */
  pending(): Promise<QueuedAction[]>;
}

export function createOfflineQueue(options: {
  store: QueueStore;
  /** Must THROW on failure; the error's `status` tells a rejection from an outage. */
  handlers: Record<string, (payload: unknown, action: QueuedAction) => Awaitable<void>>;
  /** Default: 400–499. */
  isRejection?: (error: unknown) => boolean;
  /** The user must LEARN that offline work was refused — silence means work they believe is saved, is not. */
  onRejected?: (action: QueuedAction, error: unknown) => void;
  logger?: { warn?(m: string): void; error?(m: string): void };
}): OfflineQueue;

/* ────────────────────────── Writing to support ────────────────────────── */

export interface SupportLink {
  readonly email: string;
  /** The signature block; absent facts are dropped rather than left hollow. */
  body(context?: Record<string, unknown>, labels?: Record<string, string>): string;
  /** The complete mailto:, everything encoded. */
  mailto(subject: string, text?: string, address?: string): string;
}

export function createSupportLink(options: {
  email: string;
  fields?: Array<{ key: string; label: string }>;
  separator?: string;
}): SupportLink;

/* ─────────────────── The dashboard's destinations ─────────────────── */

export interface Tool {
  id: string;
  path: string;
  /** Roles allowed to reach it. Anything not listed is refused. */
  roles: string[];
  titleKey?: string;
  subtitleKey?: string;
  kind?: string;
  /** Absent means the tool needs a context chosen first. */
  endpoint?: string;
  [key: string]: unknown;
}

export interface ToolCatalog {
  /** In declaration order — that order is what the dashboard renders. */
  readonly all: readonly Readonly<Tool>[];
  byId(id: string | undefined): Readonly<Tool> | undefined;
  /** Decides what a screen OFFERS. The server decides what it grants. */
  canAccess(tool: Readonly<Tool> | undefined, role: string | undefined): boolean;
  forRole(role: string | undefined): readonly Readonly<Tool>[];
  hasPath(path: string): boolean;
  needsContext(tool: Readonly<Tool> | undefined): boolean;
}

export function createToolCatalog(tools?: Tool[]): ToolCatalog;

/* ────────────────── Reading an unfamiliar payload ────────────────── */

export const TITLE_FIELDS: string[];
export const SUBTITLE_FIELDS: string[];

/** The rows to render, whatever the envelope. Never throws. */
export function readResourceItems(data: unknown): Record<string, unknown>[];
export function readResourceTitle(item: Record<string, unknown> | null | undefined, fields?: string[]): string;
export function readResourceSubtitle(item: Record<string, unknown> | null | undefined, fields?: string[]): string;

/* ─────────────────── Settings menu and landing ─────────────────── */

export interface SettingsGroupEntry<T> {
  group: string;
  sections: T[];
}

export interface SettingsMenu {
  readonly groups: string[];
  readonly fallbackGroup: string;
  /** An unknown section lands in the fallback group — shown, never dropped. */
  groupOf(sectionId: string): string;
  /** Declared group order; empty groups omitted. */
  group<T extends { id?: string }>(sections: readonly T[] | null | undefined): SettingsGroupEntry<T>[];
}

export function createSettingsMenu(options: {
  groups: string[];
  sectionGroups?: Record<string, string>;
  fallbackGroup?: string;
}): SettingsMenu;

export interface HomeRoutes {
  readonly routes: Record<string, string>;
  /** Must stay a page an unmapped role may legitimately see. */
  readonly fallback: string;
  forRole(role: string | undefined): string;
}

export function createHomeRoutes(options: {
  routes: Record<string, string>;
  fallback: string;
}): HomeRoutes;
