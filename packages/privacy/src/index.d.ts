export interface RedactionPattern {
  name?: string;
  pattern: RegExp;
  replacement: string | ((...args: string[]) => string);
}

export interface Redactor {
  /** Redact a string, object, array — anything you were about to log. Never mutates. */
  redact<T>(data: T): T;
  redactString(text: string): string;
  patterns: RedactionPattern[];
  secretKeys: string[];
}

export function createRedactor(options?: {
  /** Replaces the defaults entirely. */
  patterns?: RedactionPattern[];
  /** Added BEFORE the defaults — specific patterns must win over generic ones. */
  extra?: RedactionPattern[];
  secretKeys?: string[];
  mask?: string;
  maxDepth?: number;
}): Redactor;

export const DEFAULT_PATTERNS: RedactionPattern[];
export const DEFAULT_SECRET_KEYS: string[];

export interface ExportSource<Subject = unknown> {
  key: string;
  label?: string;
  collect?: (subject: Subject) => Promise<unknown> | unknown;
  /** Marks data this service does not hold: says where it lives and how to ask. */
  elsewhere?: string;
}

export interface ExportFile {
  exportedAt: string;
  sections: Record<string, unknown>;
  notIncluded: Array<{ key: string; label: string; where: string }>;
  unavailable: Array<{ key: string; label: string; reason: string }>;
  complete: boolean;
}

export interface DataExporter<Subject = unknown> {
  export(subject: Subject): Promise<ExportFile>;
  sources: string[];
}

export function createDataExporter<Subject = unknown>(options: {
  sources: Array<ExportSource<Subject>>;
  logger?: { error?(message: string): void };
}): DataExporter<Subject>;

export type FieldRule =
  | 'clear'
  | 'redact'
  | string
  | ((value: unknown, context: { token: string; field: string; record: Record<string, unknown> }) => unknown);

export interface AnonymisationResult {
  token: string;
  changed: string[];
  skipped: string[];
}

export interface Anonymizer {
  /** Rewrites identifying fields in place. Does NOT save. */
  anonymise(record: Record<string, unknown>, extra?: Record<string, unknown>): Promise<AnonymisationResult>;
  fields: string[];
}

export function createAnonymizer(options: {
  fields: Record<string, FieldRule>;
  placeholder?: string;
  token?: () => string;
  has?: (record: Record<string, unknown>, field: string) => boolean;
  onAnonymised?: (record: Record<string, unknown>, context: { token: string; changed: string[] }) => Promise<void> | void;
}): Anonymizer;

export function defaultToken(): string;

export type ErasureStatus = 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';

export interface ErasureRequest {
  id: string;
  subject: unknown;
  requestedBy: unknown;
  reason: string | null;
  status: ErasureStatus;
  requestedAt: Date;
  reviewedBy?: unknown;
  reviewedAt?: Date;
  reviewNote?: string | null;
  completedAt?: Date;
  failedAt?: Date;
  failureReason?: string;
  [key: string]: unknown;
}

export interface ErasureStore {
  create(data: Record<string, unknown>): Promise<ErasureRequest>;
  find(id: string): Promise<ErasureRequest | null>;
  update(id: string, patch: Record<string, unknown>): Promise<ErasureRequest | null>;
  list?(filter?: Record<string, unknown>): Promise<ErasureRequest[]>;
}

export function createMemoryErasureStore(): ErasureStore & {
  list(filter?: Record<string, unknown>): Promise<ErasureRequest[]>;
  size(): number;
};

export class ErasureError extends Error {
  statusCode: number;
}

export interface ErasureWorkflow {
  request(input: { subject: unknown; reason?: string; requestedBy?: unknown }): Promise<ErasureRequest>;
  /** Executes the erasure. Refuses self-approval and anything already decided. */
  approve(id: string, review: { reviewedBy: unknown; note?: string }): Promise<{ request: ErasureRequest; result: unknown }>;
  reject(id: string, review: { reviewedBy: unknown; note?: string }): Promise<ErasureRequest>;
  pending(filter?: Record<string, unknown>): Promise<ErasureRequest[]>;
  load(id: string): Promise<ErasureRequest>;
  PENDING: 'pending';
  APPROVED: 'approved';
  REJECTED: 'rejected';
  COMPLETED: 'completed';
  FAILED: 'failed';
}

export function createErasureWorkflow(options: {
  store: ErasureStore;
  erase: (request: ErasureRequest) => Promise<unknown> | unknown;
  now?: () => Date;
  logger?: { info?(message: string): void; error?(message: string): void };
}): ErasureWorkflow;

export const PENDING: 'pending';
export const APPROVED: 'approved';
export const REJECTED: 'rejected';
export const COMPLETED: 'completed';
export const FAILED: 'failed';
