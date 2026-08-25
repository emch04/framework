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
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
}): PushSender<Subscription, Payload>;
