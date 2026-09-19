export type Awaitable<T> = T | Promise<T>;

/* ───────────────────────────── Email ───────────────────────────── */

/** Strip anything that could end a header and start a new one. */
export function sanitizeHeader(value: unknown, options?: { maxLength?: number }): string;
/** Returns the address, or null if it is not one — never a repaired guess. */
export function sanitizeAddress(value: unknown): string | null;
/** `"Name" <address>`, or null when there is no valid address. */
export function formatSender(address: unknown, name?: unknown): string | null;
export function hasHeaderInjection(value: unknown): boolean;
export const EMAIL: RegExp;

export interface OutgoingMessage {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  cc: string[];
  bcc: string[];
  replyTo?: string;
  attachments?: unknown;
}

export interface MailChannel {
  send(message: OutgoingMessage): Promise<unknown> | unknown;
  from?: string;
  fromName?: string;
  replyTo?: string;
}

export interface SendResult {
  sent: boolean;
  channel: string;
  to: string[];
  reason?: 'unknown-channel' | 'no-recipient' | 'no-subject' | 'no-body' | 'no-sender' | 'send-failed';
  error?: string;
  result?: unknown;
}

export interface Mailer {
  /** Never throws: the thing the mail was about has usually already happened. */
  send(message: {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    channel?: string;
    from?: string;
    fromName?: string;
    replyTo?: string;
    cc?: string | string[];
    bcc?: string | string[];
    attachments?: unknown;
  }): Promise<SendResult>;
  channels: string[];
  defaultChannel: string;
}

export function createMailer(options: {
  channels: Record<string, MailChannel>;
  defaultChannel?: string;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
  subjectMaxLength?: number;
}): Mailer;

export interface CaptureChannel extends MailChannel {
  sent: OutgoingMessage[];
  last(): OutgoingMessage | null;
  clear(): void;
}

/** A channel that records instead of sending — for tests and development. */
export function createCaptureChannel(config?: { from?: string; fromName?: string; replyTo?: string }): CaptureChannel;

export interface EmailTheme {
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  accent?: string;
  accentText?: string;
  border?: string;
  fontFamily?: string;
  width?: number;
}

export type EmailBlock =
  | { type: 'heading' | 'paragraph' | 'note'; text: string }
  | { type: 'code'; value: string }
  | { type: 'button'; label: string; url: string }
  | { type: 'divider' }
  /** Not escaped — named so it can never happen by accident. */
  | { type: 'html'; html: string };

export function renderEmail(options?: {
  blocks?: EmailBlock[];
  preheader?: string;
  footer?: string;
  theme?: EmailTheme;
}): string;

/** The same blocks as plain text — spam filters and screen readers want it. */
export function renderText(options?: { blocks?: EmailBlock[] }): string;

export function escapeHtml(value: unknown): string;
export const DEFAULT_THEME: Required<EmailTheme>;

/* ────────────────────────── SMS and push ────────────────────────── */

/** Digits and one leading plus, or null — never a guess. */
export function normalizePhone(value: unknown): string | null;

export interface SmsResult {
  sent: boolean;
  simulated?: boolean;
  to?: string;
  reason?: 'no-recipient' | 'no-text' | 'send-failed';
  error?: string;
  result?: unknown;
}

export interface SmsSender {
  /** Never throws. Without a transport, the send is a LOUD simulation. */
  send(to: unknown, text: unknown): Promise<SmsResult>;
  normalizePhone(value: unknown): string | null;
}

export function createSmsSender(options?: {
  transport?: (message: { to: string; text: string }) => Awaitable<unknown>;
  /** Hard cap — an unbounded text concatenated into an SMS is how a bug becomes a bill. Default 480. */
  maxLength?: number;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
}): SmsSender;

export type PushStatus = 'delivered' | 'gone' | 'failed';

export interface PushReport {
  delivered: number;
  gone: number;
  failed: number;
  errors: string[];
}

export interface PushSender<Subscription = unknown, Payload = unknown> {
  /** Never throws. 'gone' means the subscription is dead and was handed to onGone. */
  send(subscription: Subscription, payload: Payload): Promise<{ status: PushStatus; error?: string }>;
  /** One dead or failing subscription never stops the others. */
  broadcast(subscriptions: Subscription[] | null | undefined, payload: Payload): Promise<PushReport>;
}

export function createPushSender<Subscription = unknown, Payload = unknown>(options: {
  /** webpush.sendNotification, Expo's client… Must throw with the provider status reachable on the error. */
  transport: (subscription: Subscription, payload: Payload) => Awaitable<unknown>;
  /** Default: statusCode/status/response.status of 404 or 410. */
  isGone?: (error: unknown) => boolean;
  /** Delete the dead subscription from your store — the point of the module. */
  onGone?: (subscription: Subscription) => Awaitable<void>;
  /** Maximum simultaneous sends. Default 10. */
  concurrency?: number;
  /** Provider deadline for one send, in milliseconds. Default 30000. */
  timeoutMs?: number;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
}): PushSender<Subscription, Payload>;

/* ───────────────────────── The notification inbox ───────────────────────── */

export interface InboxPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface InboxPage<Item> {
  notifications: Item[];
  unreadCount: number;
  pagination: InboxPagination;
}

/**
 * The storage contract. Every call carries `ownerId`, and the store MUST apply
 * it inside the query — the owner in the match is the only barrier.
 * `list` returns newest first, ties broken by id (descending).
 * `remove`, `removeRead`, `markRead`, `markAllRead` return how many documents changed.
 */
export interface InboxStore<Item = InboxItem> {
  list(query: { ownerId: unknown; offset: number; limit: number }): Awaitable<Item[]>;
  count(query: { ownerId: unknown; read?: boolean }): Awaitable<number>;
  get(query: { ownerId: unknown; id: unknown }): Awaitable<Item | null | undefined>;
  remove(query: { ownerId: unknown; id: unknown }): Awaitable<number>;
  removeRead(query: { ownerId: unknown }): Awaitable<number>;
  markRead(query: { ownerId: unknown; id: unknown }): Awaitable<number>;
  markAllRead(query: { ownerId: unknown }): Awaitable<number>;
}

export interface InboxItem {
  id: string | number;
  ownerId: string | number;
  read?: boolean;
  createdAt?: Date | string | number;
  [field: string]: unknown;
}

export interface NotificationInbox<Item = InboxItem> {
  /** Throws when ownerId is missing — a programming error, never a user one. */
  list(ownerId: unknown, query?: { page?: unknown; limit?: unknown }): Promise<InboxPage<Item>>;
  /** Absent and "belongs to someone else" both return null. */
  get(ownerId: unknown, id: unknown): Promise<Item | null>;
  remove(ownerId: unknown, id: unknown): Promise<{ removed: boolean; unreadCount?: number }>;
  /** Read notifications only — unread ones are never tidied away. */
  removeRead(ownerId: unknown): Promise<{ deleted: number; unreadCount: number }>;
  markRead(ownerId: unknown, id: unknown): Promise<{ updated: boolean; unreadCount?: number }>;
  markAllRead(ownerId: unknown): Promise<{ updated: number; unreadCount: number }>;
  pageSize: number;
  maxPageSize: number;
}

export function createNotificationInbox<Item = InboxItem>(options: {
  store: InboxStore<Item>;
  /** Default 50. */
  pageSize?: number;
  /** Default 100. */
  maxPageSize?: number;
  /** An id failing this is "not found" without reaching the store. */
  isValidId?: (id: unknown) => boolean;
}): NotificationInbox<Item>;

export interface MemoryInboxStore extends InboxStore<InboxItem> {
  add(item: Partial<InboxItem> & { id: string | number; ownerId: string | number }): InboxItem;
  all(): InboxItem[];
}

/** The reference adapter: applies the owner filter like a database would, refuses ownerless queries. */
export function createMemoryInboxStore(options?: { items?: InboxItem[] }): MemoryInboxStore;

export type InboxHandler = (req: any, res: any, next?: (error?: unknown) => unknown) => Promise<unknown>;

export interface InboxHandlers {
  list: InboxHandler;
  get: InboxHandler;
  remove: InboxHandler;
  removeRead: InboxHandler;
  markRead: InboxHandler;
  markAllRead: InboxHandler;
}

export function createInboxHandlers(inbox: NotificationInbox<any>, options?: {
  /** From the session, never from the body or the query. Default req.user.id. */
  owner?: (req: any) => unknown;
  /** Your response envelope. Default res.status(status).json(body). */
  respond?: (res: any, status: number, body: unknown) => unknown;
  notFoundMessage?: string;
}): InboxHandlers;

export interface RouterLike {
  get(path: string, handler: InboxHandler): unknown;
  patch(path: string, handler: InboxHandler): unknown;
  delete(path: string, handler: InboxHandler): unknown;
}

/** Registers fixed paths (`/read-all`, `/read`) BEFORE `/:id`. */
export function mountInbox<Router extends RouterLike>(router: Router, handlers: InboxHandlers): Router;

/* ─────────────────────── Translated notifications ─────────────────────── */

export interface NotificationContent {
  title?: string;
  message?: string;
  /** A neutral line that replaces the message on the lock screen only. */
  pushBody?: string;
}

export type NotificationTemplate<Params = any> = NotificationContent | ((params: Params) => NotificationContent);

export type NotificationEntries = Record<string, Record<string, NotificationTemplate>>;

export interface RenderedNotification {
  key: string;
  /** The language actually rendered — the default when the requested one is missing. */
  language: string;
  title: string;
  message: string;
  /** What a push may show: the neutral body when the entry has one, the message otherwise. */
  push: { title: string; body: string };
  neutralPush: boolean;
}

export interface NotificationCatalogAudit {
  missing: Array<{ key: string; language: string }>;
  /** A neutral push declared in some languages and forgotten in these. */
  pushBodyGaps: Array<{ key: string; languages: string[] }>;
  placeholders: Array<{ key: string; language: string; text: string }>;
  errors: Array<{ key: string; language: string; error: string }>;
}

export interface NotificationCatalog {
  languages: string[];
  defaultLanguage: string;
  /** Throws on an unknown key. */
  render(key: string, language?: string | null, params?: Record<string, unknown>): RenderedNotification;
  audit(options?: { params?: Record<string, Record<string, unknown>> }): NotificationCatalogAudit;
  has(key: string): boolean;
  keys(): string[];
}

export function createNotificationCatalog(options: {
  languages: string[];
  defaultLanguage?: string;
  /** One object, or several (one per domain) — a key declared twice throws. */
  entries: NotificationEntries | NotificationEntries[];
}): NotificationCatalog;
