export interface JsonResponder {
  json(payload: unknown): unknown;
}

export interface ResponseLike {
  status(statusCode: number): JsonResponder;
  setHeader?(name: string, value: string): unknown;
  set?(name: string, value: string): unknown;
}

export interface RequestLike {
  headers?: Record<string, string | undefined>;
  log?: {
    error?: (...args: unknown[]) => unknown;
  };
  originalUrl?: string;
  requestId?: string;
  url?: string;
  [key: string]: unknown;
}

export type NextFunction = (error?: unknown) => unknown;
export type RequestHandler = (req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;
export type ErrorRequestHandler = (err: Error & { status?: number; statusCode?: number }, req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;

export interface ApiResponsePayload<T = unknown> {
  success: boolean;
  message: string;
  data: T | null;
  timestamp: string;
  error?: string;
}

export function apiResponse<T = unknown>(
  res: ResponseLike,
  statusCode: number,
  message: string,
  data?: T | null,
  success?: boolean
): unknown;

export function asyncHandler(fn: RequestHandler): RequestHandler;

export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

export function createLogger(serviceName?: string): Logger;

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  constructor(message: string, statusCode?: number);
}

export const errorMiddleware: ErrorRequestHandler;
export function notFoundMiddleware(req: RequestLike, res: ResponseLike): unknown;
export const requestIdMiddleware: RequestHandler;

export interface ValidationLike {
  run(req: RequestLike): unknown | Promise<unknown>;
}

export function validateMiddleware(validations?: ValidationLike[]): RequestHandler;

export type EnvDefault = string | number | boolean | null | undefined;

export interface EnvDefinition<TInput = string | EnvDefault, TOutput = TInput> {
  default?: EnvDefault;
  required?: boolean;
  transform?: (value: TInput) => TOutput;
  validate?: (value: TOutput) => boolean;
}

export type EnvSchema = Record<string, EnvDefault | EnvDefinition<any, any>>;

export type LoadEnvValue<T> =
  T extends { transform: (...args: any[]) => infer R }
    ? R
    : T extends { default: infer D }
      ? D | string | undefined
      : T extends EnvDefault
        ? T | string | undefined
        : string | undefined;

export type LoadedEnv<TSchema extends EnvSchema> = {
  [K in keyof TSchema]: LoadEnvValue<TSchema[K]>;
};

export function loadEnv<TSchema extends EnvSchema = EnvSchema>(schema?: TSchema): LoadedEnv<TSchema>;

/* ────────────────────────── Idempotency ────────────────────────── */

export type IdempotencyStatus = 'in_flight' | 'done';

export interface StoredIdempotentResponse {
  statusCode: number;
  body: unknown;
}

export interface IdempotencyRecord<R = unknown> {
  id: string;
  /** Unique per claim: completes and releases only apply to the claim that holds it. */
  token: string;
  status: IdempotencyStatus;
  payloadHash: string;
  response: R | null;
  createdAt: Date | string;
  /** Stores with a TTL index can expire on this field. */
  expiresAt: Date | string;
}

export interface IdempotencyStore<R = unknown> {
  /** ATOMIC insert-if-absent. `record` is the existing one when not acquired. */
  acquire(id: string, entry: IdempotencyRecord<R>): Promise<{ acquired: boolean; record: IdempotencyRecord<R> }>;
  /** Marks done, only if the record still carries `token`. */
  complete(id: string, token: string, response: R | null): Promise<unknown>;
  /** Deletes, only if the record still carries `token`. */
  release(id: string, token: string): Promise<unknown>;
}

export function createMemoryIdempotencyStore<R = unknown>(options?: { now?: () => number }): IdempotencyStore<R> & {
  get(id: string): IdempotencyRecord<R> | null;
  size(): number;
};

export type IdempotencyReason = 'invalid_key' | 'in_flight' | 'conflict' | 'unavailable';

export class IdempotencyError extends Error {
  reason: IdempotencyReason;
  statusCode: number;
  constructor(reason: IdempotencyReason, statusCode: number, message?: string);
}

export interface IdempotencyInput {
  /** At least the caller identity; the middleware adds method and path. */
  scope: Array<string | number>;
  key: string;
  payload?: unknown;
}

export type IdempotencyClaim<R = unknown> =
  | { action: 'replay'; response: R | null }
  | { action: 'execute'; id: string; finish(response: R): Promise<void>; abort(): Promise<void> };

export interface IdempotencyOptions<R = unknown> {
  store: IdempotencyStore<R>;
  /** Retention of a key, in ms. Default 24h. */
  ttlMs?: number;
  now?: () => number;
  keyPattern?: RegExp;
  messages?: Partial<Record<IdempotencyReason, string>>;
  logger?: { error(message: string): void; warn?(message: string): void };
}

export interface Idempotency<R = unknown> {
  begin(input: IdempotencyInput): Promise<IdempotencyClaim<R>>;
  run<T extends R>(
    input: IdempotencyInput,
    fn: () => T | Promise<T>,
    options?: { remember?: (result: T) => boolean }
  ): Promise<{ replayed: boolean; result: T }>;
  ttlMs: number;
}

export function createIdempotency<R = unknown>(options: IdempotencyOptions<R>): Idempotency<R>;

export interface IdempotencyMiddlewareOptions extends IdempotencyOptions<StoredIdempotentResponse> {
  /** REQUIRED: a STABLE, VERIFIED caller id (the account, not the token). null = shared anonymous namespace. */
  identify(req: RequestLike): string | number | null | undefined | Promise<string | number | null | undefined>;
  engine?: Idempotency<StoredIdempotentResponse>;
  header?: string;
  methods?: string[];
  replayHeader?: string;
  remember?: (statusCode: number) => boolean;
  /** Default 'deny' (503): no unguarded execution while the store is down. */
  onStoreError?: 'deny' | 'allow';
  respond?: (res: ResponseLike, payload: { status: number; reason: IdempotencyReason; message: string }) => unknown;
}

export function idempotencyMiddleware(options: IdempotencyMiddlewareOptions): RequestHandler;

export function decideIdempotency(input: {
  record: IdempotencyRecord | null;
  payloadHash: string;
  now?: number;
}): { action: 'execute' | 'expired' | 'conflict' | 'inFlight' } | { action: 'replay'; response: unknown };

export function hashIdempotencyPayload(payload: unknown): string;
export function isValidIdempotencyKey(key: unknown, pattern?: RegExp): boolean;
export const IDEMPOTENCY_TTL_MS: number;
