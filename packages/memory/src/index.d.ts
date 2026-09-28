type Awaitable<T> = T | Promise<T>;

/** Where a memory lives: one person, in one partition chosen by the consumer ('' for none). */
export interface MemoryWhere {
  ownerId: string;
  scope?: string;
}

/** A place as the store receives it: always both fields. */
export interface MemoryPlace {
  ownerId: string;
  scope: string;
}

export type MemoryChannel = 'explicit' | 'auto' | 'background';

export interface MemorySource {
  channel?: MemoryChannel | string;
  ref?: string;
  [key: string]: unknown;
}

/** What the store holds. `text` is ciphertext when a cipher is configured. */
export interface MemoryRecord {
  id: string;
  ownerId: string;
  scope: string;
  role: string | null;
  text: string;
  kind: string;
  importance: number;
  source: MemorySource;
  vector: number[] | null;
  vectorSource: string | null;
  supersededBy: string | null;
  seenAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Set by search() only. */
  score?: number;
}

/** What leaves the package: clear text, never the vector. */
export interface Memory {
  id: string;
  ownerId: string;
  scope: string;
  role: string | null;
  text: string;
  kind: string;
  importance: number;
  source: MemorySource;
  supersededBy: string | null;
  seenAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  hasVector: boolean;
  score?: number;
}

export interface MemoryListFilter {
  /** Default 'active' (not superseded). */
  state?: 'active' | 'superseded' | 'all';
  supersededBy?: string;
  kinds?: string[];
  channel?: string;
  seen?: boolean;
  createdAfter?: Date | null;
  createdBefore?: Date | null;
  limit?: number;
}

export interface MemorySearchInput {
  text: string;
  vector: number[] | null;
  vectorSource: string | null;
  kinds?: string[];
  createdAfter?: Date | null;
  createdBefore?: Date | null;
  limit?: number;
}

/**
 * The storage contract. Every method but purgeOwner and listNeedingVector
 * is bound to one place and must never read or write outside it. Returned
 * records are copies. Prove an adapter with runStoreContract().
 */
export interface MemoryStore {
  insert(record: MemoryRecord): Awaitable<MemoryRecord>;
  /** Any state, superseded included; null outside the place. */
  get(where: MemoryPlace, id: string): Awaitable<MemoryRecord | null>;
  /** Newest first by createdAt. */
  list(where: MemoryPlace, filter?: MemoryListFilter): Awaitable<MemoryRecord[]>;
  /** Never changes id, ownerId or scope. With onlyActive, null when the record is superseded (compare-and-set). */
  update(where: MemoryPlace, id: string, patch: Partial<MemoryRecord>, options?: { onlyActive?: boolean }): Awaitable<MemoryRecord | null>;
  remove(where: MemoryPlace, ids: string[]): Awaitable<number>;
  removeAll(where: MemoryPlace): Awaitable<number>;
  /** Every scope of one owner: memories, settings and consolidation marks. */
  purgeOwner(ownerId: string): Awaitable<{ memories: number; settings: number; refs?: number }>;
  getSettings(where: MemoryPlace): Awaitable<{ paused: boolean; [key: string]: unknown }>;
  setSettings(where: MemoryPlace, patch: { paused?: boolean; [key: string]: unknown }): Awaitable<{ paused: boolean; [key: string]: unknown }>;
  /** Optional: true the first time a ref is claimed in a place. */
  claimRef?(where: MemoryPlace, ref: string): Awaitable<boolean>;
  releaseRef?(where: MemoryPlace, ref: string): Awaitable<void>;
  /** Optional: ranked candidates, active only; semantic compares vectors of `vectorSource` only. Ignored when a cipher is set. */
  search?(where: MemoryPlace, input: MemorySearchInput): Awaitable<{ semantic: MemoryRecord[]; lexical: MemoryRecord[] }>;
  /** Optional, every owner: active records without a vector, or (with source) from another source. */
  listNeedingVector?(options: { limit?: number; source?: string }): Awaitable<MemoryRecord[]>;
}

export interface Candidate {
  text: string;
  kind: string | null;
  importance: number;
  role: string | null;
  explicit: boolean;
  personName: string;
  alreadyPresent?: string;
  names?: string[];
}

/** Returns a refusal code, or null/undefined to let the memory through. */
export type MemoryRule = (candidate: Candidate) => Awaitable<string | null | undefined>;

export type EmbedFunction = (
  text: string,
  options: { purpose: 'passage' | 'query'; source?: string }
) => Awaitable<number[] | { vector: number[]; source?: string }>;

export interface ConsolidationRequest {
  system: string;
  prompt: string;
}

export type LlmFunction = (request: ConsolidationRequest & { purpose: string; where: MemoryPlace }) => Awaitable<string | Record<string, unknown>>;

export interface MemoryLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export type TranscriptTurn = { role?: string; text?: string; content?: string };

export interface MemoryOptions {
  store: MemoryStore;
  /** Allowed kinds. Default DEFAULT_KINDS. */
  kinds?: string[];
  /** Other words a model may use for a kind: { alias: kind }. Folded (case, accents). */
  kindAliases?: Record<string, string>;
  /** Kind given to an unknown kind. Default null: refused with 'invalid_kind'. */
  defaultKind?: string | null;
  /** Kinds each role may keep; a role absent here may keep every kind. */
  roleKinds?: Record<string, string[]>;
  /** Content rules, in order, after the structural checks. */
  rules?: MemoryRule[];
  /** Names of other people that must not be written into this person's memories. */
  namesOf?: (where: MemoryPlace, ctx?: unknown) => Awaitable<string[]>;
  embed?: EmbedFunction;
  /** Applied to every text sent to embed or to the model. Default identity. */
  mask?: (text: string, where: MemoryPlace) => Awaitable<string>;
  llm?: LlmFunction;
  cipher?: { encrypt(text: string): Awaitable<string>; decrypt(value: string): Awaitable<string> };
  now?: () => Date;
  generateId?: () => string;
  logger?: MemoryLogger;
  /** Serialise writes for one place. Default: an in-process queue. */
  withLock?: <T>(where: MemoryPlace, fn: () => Promise<T>) => Promise<T>;
  /** Default 500. */
  maxTextLength?: number;
  /** Active memories per place. Default 300; 0 or null for no cap. */
  maxActive?: number | null;
  /** Cosine at or above which a new memory replaces an old one. Default 0.92. */
  duplicateThreshold?: number;
  /** Cosine below which a meaning match is dropped from recall. Default null (none). */
  minSimilarity?: number | null;
  consolidationPrompt?: (input: { kinds: string[]; known: Array<{ id: string; text: string }>; transcript: string; language?: string; role?: string }) => ConsolidationRequest;
  /** The person asked for this fact to be remembered (lets rules with allowWhenExplicit pass). */
  isExplicitFact?: (fact: { text: string; kind?: unknown; importance?: unknown }, transcript: unknown, where: MemoryPlace) => Awaitable<boolean>;
  /** Known memories shown to the model. Default 60. */
  knownForConsolidation?: number;
  /** Characters of each known memory shown. Default 240. */
  knownTextMax?: number;
  /** Characters of transcript sent. Default 40000. */
  transcriptMax?: number;
}

export type Refusal = { ok: false; reason: string };

export interface RememberInput {
  text: string;
  kind: string;
  importance?: number | string;
  role?: string | null;
  explicit?: boolean;
  personName?: string;
  channel?: MemoryChannel;
  source?: Record<string, unknown>;
  ctx?: unknown;
}

export interface RecallInput {
  query: string;
  kinds?: string[];
  after?: string | Date;
  before?: string | Date;
  limit?: number;
}

export interface ConsolidateInput {
  transcript: string | TranscriptTurn[];
  ref?: string;
  role?: string;
  personName?: string;
  language?: string;
  source?: Record<string, unknown>;
  ctx?: unknown;
}

export interface ConsolidateResult {
  status: 'done' | 'already' | 'paused' | 'empty' | 'unavailable' | 'failed';
  added: number;
  corrected: number;
  refused: number;
  summary: string | null;
}

export interface MemoryService {
  remember(where: MemoryWhere, input: RememberInput): Promise<{ ok: true; memory: Memory; supersededId: string | null } | Refusal>;
  recall(where: MemoryWhere, input: RecallInput | string): Promise<Memory[]>;
  update(
    where: MemoryWhere,
    id: string,
    changes: { text?: string; kind?: string; importance?: number | string },
    options?: { personName?: string; explicit?: boolean; source?: Record<string, unknown>; ctx?: unknown }
  ): Promise<{ ok: true; memory: Memory; supersededId: string | null; unchanged?: boolean } | Refusal>;
  undo(where: MemoryWhere, id: string): Promise<boolean>;
  forget(where: MemoryWhere, id: string): Promise<boolean>;
  eraseAll(where: MemoryWhere): Promise<number>;
  purgeOwner(ownerId: string): Promise<{ memories: number; settings: number; refs?: number }>;
  get(where: MemoryWhere, id: string): Promise<Memory | null>;
  list(where: MemoryWhere, filter?: { kinds?: string[]; limit?: number }): Promise<Memory[]>;
  listUnseen(where: MemoryWhere): Promise<Memory[]>;
  markSeen(where: MemoryWhere, ids: string[]): Promise<number>;
  isPaused(where: MemoryWhere): Promise<boolean>;
  setPaused(where: MemoryWhere, paused: boolean): Promise<boolean>;
  portrait(where: MemoryWhere, options?: PortraitOptions & { masked?: boolean }): Promise<string>;
  consolidate(where: MemoryWhere, input: ConsolidateInput): Promise<ConsolidateResult>;
  reindex(options?: { limit?: number; source?: string }): Promise<{ updated: number; failed: number }>;
  readonly kinds: readonly string[];
  normalizeKind(value: unknown, fallback?: string | null): string | null;
}

export function createMemory(options: MemoryOptions): MemoryService;

export class MemoryError extends Error {
  constructor(code: string, message?: string);
  code: string;
}

export const DEFAULT_KINDS: readonly string[];
export const CHANNELS: Readonly<{ EXPLICIT: 'explicit'; AUTO: 'auto'; BACKGROUND: 'background' }>;
export const REASONS: Readonly<{
  EMPTY: 'empty';
  TOO_LONG: 'too_long';
  INVALID_KIND: 'invalid_kind';
  KIND_NOT_ALLOWED: 'kind_not_allowed';
  OTHER_PERSON: 'other_person';
  PAUSED: 'paused';
  NOT_FOUND: 'not_found';
  CONFLICT: 'conflict';
  AI_DISABLED: 'ai_disabled';
}>;

export function createMemoryStore(): MemoryStore & {
  claimRef(where: MemoryPlace, ref: string): Promise<boolean>;
  releaseRef(where: MemoryPlace, ref: string): Promise<void>;
  search(where: MemoryPlace, input: MemorySearchInput): Promise<{ semantic: MemoryRecord[]; lexical: MemoryRecord[] }>;
  listNeedingVector(options: { limit?: number; source?: string }): Promise<MemoryRecord[]>;
  size(): number;
};

/* ---- rules and helpers ---- */

export function fold(value: unknown): string;
export function wordsOf(value: unknown): string;
export function cleanText(value: unknown): string;
export function normalizeKind(value: unknown, options?: { kinds?: string[]; aliases?: Record<string, string>; fallback?: string | null }): string | null;
export function normalizeImportance(value: unknown, fallback?: number): number;
export function mentionsName(text: string, name: string): boolean;
export function patternRule(options: {
  code: string;
  patterns: RegExp[];
  roles?: string[];
  exceptRoles?: string[];
  allowWhenExplicit?: boolean;
}): MemoryRule;
export function checkCandidate(
  candidate: Candidate,
  config: { kinds: string[]; roleKinds: Record<string, string[]>; rules: MemoryRule[]; maxTextLength: number }
): Promise<string | null>;

export interface PortraitOptions {
  /** Default 1200. */
  maxLength?: number;
  /** Default 4. */
  minImportance?: number;
  format?: (memory: { text: string; importance: number }) => string;
}

export function cosine(a: number[], b: number[]): number;
export function keywordScore(query: string, text: string): number;
export function fuseByRank(lists: string[][], k?: number): string[];
export function buildPortrait(
  memories: Array<{ text: string; importance: number; lastUsedAt?: Date | string | null; createdAt?: Date | string | null }>,
  options?: PortraitOptions
): string;

export function parseModelJson(value: unknown): Record<string, unknown>;
export function defaultConsolidationPrompt(input: {
  kinds: string[];
  known: Array<{ id: string; text: string }>;
  transcript: string;
  language?: string;
  role?: string;
}): ConsolidationRequest;
export function transcriptText(transcript: unknown): string;

/* ---- tools for @astratra/ai ---- */

/** Same shape as @astratra/ai's ToolDefinition. */
export interface MemoryToolDefinition {
  name: string;
  description: string;
  type: string;
  roles: string[];
  params: Record<string, unknown>;
  handler(params: Record<string, unknown>, ctx: Record<string, unknown>): Promise<MemoryToolResult>;
}

export type MemoryToolResult =
  | { ok: true; code: 'memory_saved' | 'memory_corrected'; memory: Pick<Memory, 'id' | 'text' | 'kind' | 'importance'>; undo: { id: string } | null; message?: string }
  | { ok: true; code: 'memories_found'; memories: Array<Pick<Memory, 'id' | 'text' | 'kind' | 'importance' | 'createdAt' | 'lastUsedAt'>>; message?: string }
  | { ok: true; code: 'memory_forgotten'; id: string; message?: string }
  | { ok: false; code: 'refused'; reason: string; message?: string };

export interface MemoryToolsOptions {
  memory: MemoryService;
  roles: string[];
  whereOf: (ctx: Record<string, any>) => MemoryWhere;
  roleOf?: (ctx: Record<string, any>) => string | null | undefined;
  personNameOf?: (ctx: Record<string, any>) => string;
  isExplicit?: (params: Record<string, unknown>, ctx: Record<string, any>) => Awaitable<boolean>;
  sourceOf?: (params: Record<string, unknown>, ctx: Record<string, any>) => Record<string, unknown>;
  isAiEnabled?: (ctx: Record<string, any>) => Awaitable<boolean>;
  translate?: (code: string, ctx: Record<string, any>) => string;
  names?: Partial<Record<'remember' | 'recall' | 'update' | 'forget', string>>;
  descriptions?: Partial<Record<'remember' | 'recall' | 'update' | 'forget', string>>;
}

export function createMemoryTools(options: MemoryToolsOptions): MemoryToolDefinition[];
export const DEFAULT_TOOL_NAMES: Readonly<Record<'remember' | 'recall' | 'update' | 'forget', string>>;
export const DEFAULT_TOOL_DESCRIPTIONS: Readonly<Record<'remember' | 'recall' | 'update' | 'forget', string>>;

/* ---- handlers for a "my memories" screen ---- */

export interface MemoryHandlers {
  list(where: MemoryWhere): Promise<{ ok: true; paused: boolean; memories: Memory[] }>;
  listUnseen(where: MemoryWhere): Promise<{ ok: true; memories: Memory[] }>;
  markSeen(where: MemoryWhere, input: { ids?: unknown[] }): Promise<{ ok: true; seen: number }>;
  setPaused(where: MemoryWhere, input: { paused?: unknown }): Promise<{ ok: true; paused: boolean }>;
  undo(where: MemoryWhere, input: { id?: string }): Promise<{ ok: true; undone: true } | Refusal>;
  erase(where: MemoryWhere, input: { id?: string }): Promise<{ ok: true; erased: true } | Refusal>;
  eraseAll(where: MemoryWhere): Promise<{ ok: true; erased: number }>;
  purgeOwner(ownerId: string): Promise<{ ok: true; memories: number; settings: number; refs?: number }>;
  update(
    where: MemoryWhere,
    input: { id?: string; text?: string; kind?: string; importance?: number | string; personName?: string }
  ): Promise<{ ok: true; memory: Memory; supersededId: string | null } | Refusal>;
}

export function createMemoryHandlers(options: { memory: MemoryService; isAiEnabled?: (where: MemoryWhere) => Awaitable<boolean> }): MemoryHandlers;
export const PRIVACY_OPERATIONS: readonly string[];
export const AI_OPERATIONS: readonly string[];
export function worksWithoutAi(operation: string): boolean;

/* ---- store contract ---- */

export interface ContractRunner {
  describe?: (name: string, fn: () => void) => void;
  test?: (name: string, fn: () => Promise<void> | void) => void;
  expect?: (value: unknown) => any;
}

export function runStoreContract(makeStore: () => Awaitable<MemoryStore>, runner?: ContractRunner): void;
export function contractRecord(overrides?: Partial<MemoryRecord>): MemoryRecord;
