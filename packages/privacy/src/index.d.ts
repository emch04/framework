export interface RedactionPattern {
  name?: string;
  /** Must be global (`/g`): a non-global regex would leak every match after the first. */
  pattern: RegExp;
  replacement: string | ((...args: string[]) => string);
  /** Vets a match before it is replaced (a checksum, a shape). False leaves it to the next rules. */
  validate?: (match: string) => boolean;
}

export interface InspectionResult<T> {
  value: T;
  /** Hits per rule name — never the values. `secret-key` counts fields redacted by name. */
  found: Record<string, number>;
  clean: boolean;
}

export interface Redactor {
  /** Redact a string, object, array — anything you were about to log. Never mutates. */
  redact<T>(data: T): T;
  redactString(text: string): string;
  /** Redact AND report what was found, for an audit trail or a block decision. */
  inspect<T>(data: T): InspectionResult<T>;
  patterns: RedactionPattern[];
  /** Normalised: lower case, non-alphanumerics removed. */
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
export function luhnValid(value: string): boolean;
export function ibanValid(value: string): boolean;

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

export type DeletionStatus = 'scheduled' | 'erasing' | 'erased';

export interface DeletionRecord<Subject = unknown> {
  subject: Subject;
  status: DeletionStatus;
  requestedAt: Date;
  scheduledFor: Date;
  reminderFor: Date | null;
  erasingSince: Date | null;
  erasedAt: Date | null;
  attempts: number;
  lastError: string | null;
  [key: string]: unknown;
}

export interface DateCondition { lt?: Date; lte?: Date; gt?: Date }

/** Every write is conditional: `expected` lists the fields that must still hold. */
export interface DeletionStore<Subject = unknown> {
  get(subject: Subject): Promise<DeletionRecord<Subject> | null>;
  /** Insert; resolves false if the subject already has a record. */
  create(record: DeletionRecord<Subject>): Promise<boolean>;
  update(subject: Subject, expected: Record<string, unknown>, patch: Record<string, unknown>): Promise<boolean>;
  remove(subject: Subject, expected: Record<string, unknown>): Promise<boolean>;
  list(filter: Record<string, unknown | DateCondition>): Promise<Array<DeletionRecord<Subject>>>;
}

export function createMemoryDeletionStore<Subject = unknown>(): DeletionStore<Subject> & { size(): number };

export type DeletionEvent = 'scheduled' | 'cancelled' | 'reminder' | 'erased';

export interface DeletionNoticeContext<Subject = unknown> {
  subject: Subject;
  requestedAt?: Date;
  scheduledFor?: Date;
  erasedAt?: Date;
  daysLeft?: number;
  by?: 'user' | 'sign-in';
}

export interface DeletionLock {
  /** Resolves null when another instance holds the lock — @astratra/resilience's createJobLock() fits. */
  run<T>(name: string, holdMs: number, fn: () => Promise<T> | T): Promise<T | null>;
}

export interface SweepResult {
  /** False when another instance held the lock. */
  ran: boolean;
  reminded: number;
  erased: number;
  failed: number;
  skipped: number;
}

export type DeletionRequestResult<Subject = unknown> =
  | { ok: true; record: DeletionRecord<Subject> }
  | { ok: false; reason: string };

export interface AccountDeletion<Subject = unknown> {
  request(subject: Subject, context?: Record<string, unknown>): Promise<DeletionRequestResult<Subject>>;
  cancel(subject: Subject, options?: { by?: 'user' | 'sign-in' }): Promise<{ cancelled: boolean; reason?: string }>;
  /** Call only once a session is fully granted (second factor included). Never throws. */
  onSignIn(subject: Subject): Promise<{ cancelled: boolean; reason?: string; error?: Error }>;
  status(subject: Subject): Promise<{ pending: boolean; erased: boolean; requestedAt: Date | null; scheduledFor: Date | null }>;
  isSuspended(subject: Subject): Promise<boolean>;
  /** Last warnings, then erasures that are due. Idempotent. */
  sweep(): Promise<SweepResult>;
  graceMs: number;
  reminderMs: number | null;
}

export function createAccountDeletion<Subject = unknown, Message = unknown>(options: {
  store: DeletionStore<Subject>;
  /** Must be idempotent: a pass that died half-way runs it again. */
  erase: (subject: Subject, record: DeletionRecord<Subject>) => Promise<unknown> | unknown;
  graceMs?: number;
  reminderMs?: number | null;
  /** Resolve a reason code to refuse, or null to allow. */
  canRequest?: (subject: Subject, context: Record<string, unknown>) => Promise<string | null | undefined> | string | null | undefined;
  suspend?: (subject: Subject, record: DeletionRecord<Subject>) => Promise<void> | void;
  restore?: (subject: Subject, record: DeletionRecord<Subject>) => Promise<void> | void;
  notify?: {
    /** Resolve false to report a send that did not go out. */
    send: (subject: Subject, message: Message, event: DeletionEvent) => Promise<unknown> | unknown;
    messages?: Partial<Record<DeletionEvent, (context: DeletionNoticeContext<Subject>) => Message>>;
  };
  lock?: DeletionLock;
  lockName?: string;
  lockHoldMs?: number;
  staleClaimMs?: number;
  now?: () => Date;
  logger?: { info?(message: string): void; error?(message: string): void };
}): AccountDeletion<Subject>;

export function isDeletionDue(record: { scheduledFor?: Date | string | null } | null | undefined, now?: Date): boolean;

export const DELETION_REASONS: {
  ALREADY_REQUESTED: 'already_requested';
  ALREADY_ERASED: 'already_erased';
  NOT_FOUND: 'not_found';
  ERASURE_IN_PROGRESS: 'erasure_in_progress';
};
export const CANCELLED_BY: { USER: 'user'; SIGN_IN: 'sign-in' };
export const DELETION_SCHEDULED: 'scheduled';
export const DELETION_ERASING: 'erasing';
export const DELETION_ERASED: 'erased';
export const DEFAULT_GRACE_MS: number;
