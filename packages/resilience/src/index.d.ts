export type Awaitable<T> = T | Promise<T>;
export type CircuitState = 'closed' | 'open' | 'half-open';

export const CLOSED: 'closed';
export const OPEN: 'open';
export const HALF_OPEN: 'half-open';

export class CircuitOpenError extends Error {
  code: 'CIRCUIT_OPEN';
  retryInMs: number;
}

export interface CircuitBreaker {
  call<T>(fn: () => Awaitable<T>): Promise<T>;
  wrap<Args extends unknown[], T>(fn: (...args: Args) => Awaitable<T>): (...args: Args) => Promise<T>;
  status(): { name: string; state: CircuitState; failures: number; openedAt: number | null };
  isOpen(): boolean;
  /** Close the door without waiting out the delay — for operators, after a fix. */
  reset(): void;
}

export function createCircuitBreaker(options?: {
  name?: string;
  /** Consecutive failures before opening. Default 5. */
  failureThreshold?: number;
  /** How long to refuse before probing. Default 30 000. */
  recoveryMs?: number;
  /** A 404 is an answer, not an outage — say which errors count. Default: all. */
  isFailure?: (error: unknown) => boolean;
  onStateChange?: (change: { name: string; from: CircuitState; to: CircuitState; error: unknown | null }) => void;
  now?: () => number;
}): CircuitBreaker;

export interface CacheStore {
  get(key: string): Awaitable<string | null | undefined>;
  set(key: string, data: string, ttlSeconds: number): Awaitable<void>;
  delete(key: string): Awaitable<void>;
}

export function createMemoryCacheStore(options?: {
  maxEntries?: number;
  now?: () => number;
}): CacheStore & { size(): number };

export interface Cache {
  /** A broken store reads as a miss — never as an error. */
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  /** Cache-aside with stampede protection: one computation per key under concurrency. */
  remember<T>(key: string, produce: () => Awaitable<T>, ttlSeconds?: number): Promise<T>;
}

export function createCache(options?: {
  store?: CacheStore;
  ttlSeconds?: number;
  prefix?: string;
  logger?: { warn?(message: string): void };
  maxEntries?: number;
  now?: () => number;
}): Cache;

export function retry<T>(fn: (attempt: number) => Awaitable<T>, options?: {
  /** Total tries, first included. Default 3. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Defaults to refusing anything with an HTTP status below 500. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): Promise<T>;

export function defaultShouldRetry(error: unknown): boolean;
