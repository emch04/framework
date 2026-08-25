export interface RequestLike {
  path?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

export interface ResponseLike {
  status(statusCode: number): { json(payload: unknown): unknown };
  [key: string]: unknown;
}

export type OutcomeStatus = 'handled' | 'unrelated' | 'duplicate' | 'ignored';

export const HANDLED: 'handled';
export const UNRELATED: 'unrelated';
export const DUPLICATE: 'duplicate';
export const IGNORED: 'ignored';
export const OUTCOME: symbol;

export interface Outcome {
  status: OutcomeStatus;
  reason: string | null;
}

export function isOutcome(value: unknown): boolean;
/** Handled, nothing more to say. */
export function handled(reason?: string): Outcome;
/** "Received, but not my circuit." Acknowledged with 200 so the provider stops retrying. */
export function unrelated(reason?: string): Outcome;
/** Already acted on. */
export function duplicate(reason?: string): Outcome;

export interface EventLog {
  seen(eventId: string | number): Promise<boolean> | boolean;
  record(eventId: string | number, meta?: Record<string, unknown>): Promise<void> | void;
}

export function createMemoryEventLog(options?: { limit?: number }): EventLog & { size(): number };

export interface WebhookLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface HandlerContext {
  /** Run something that must not be able to fail the webhook. Never throws. */
  sideEffect<T>(label: string, fn: () => Promise<T> | T): Promise<T | null>;
  handled(reason?: string): Outcome;
  unrelated(reason?: string): Outcome;
  duplicate(reason?: string): Outcome;
  logger: WebhookLogger;
}

export type EventHandler<Event = Record<string, unknown>> =
  (event: Event, context: HandlerContext) => Promise<Outcome | void> | Outcome | void;

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookHandler {
  receive(request: { payload: unknown; headers?: Record<string, unknown> }): Promise<WebhookResponse>;
  middleware(req: RequestLike, res: ResponseLike): Promise<void>;
  sideEffect<T>(label: string, fn: () => Promise<T> | T): Promise<T | null>;
}

export function createWebhookHandler<Event = Record<string, unknown>>(options: {
  /** Provider-specific; MUST throw when the signature does not check out. */
  verify: (input: { payload: unknown; headers: Record<string, unknown>; secret: unknown }) => Event | Promise<Event>;
  /** A value, or a function read on every call so the secret can rotate without a restart. */
  secret?: unknown | (() => unknown | Promise<unknown>);
  events: Record<string, EventHandler<Event>>;
  eventLog?: EventLog;
  eventId?: (event: Event) => string | undefined;
  logger?: WebhookLogger;
}): WebhookHandler;

export function createWebhookExemption(options: {
  paths?: string[];
  prefix?: string;
  suffix?: string;
  pattern?: RegExp;
}): (input: RequestLike | string | null) => boolean;
