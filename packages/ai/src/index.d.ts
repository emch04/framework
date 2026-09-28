export type Awaitable<T> = T | Promise<T>;

export interface ProviderModel {
  id: string;
  rpm?: number;
  rpd?: number;
  tpd?: number;
  complexity?: string[];
  [key: string]: unknown;
}

export interface Provider {
  id: string;
  models: ProviderModel[];
  /** False for a model running on this machine: the router does not mask for it. */
  external?: boolean;
  call(prompt: string, ctx: Record<string, unknown>, model: ProviderModel): Awaitable<unknown>;
  [key: string]: unknown;
}

export interface ProviderRequest {
  complexity?: string;
  estimatedTokens?: number;
  intent?: string;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface ProviderRouterConfig {
  providers?: Provider[];
  cooldownMs?: number;
  cooldownJitterMs?: number;
  maxFailures?: number;
  degradedMs?: number;
  intentRouting?: Record<string, { preferred?: string[] }>;
  redisKeyPrefix?: string;
  redisUrl?: string;
  /** One circuit per provider: a factory (providerId) => breaker, or a pool. */
  breakers?: ((providerId: string) => BreakerLike) | BreakerPool;
}

export interface ProviderStats {
  provider: string;
  rpm_now: number;
  rpm_limit: number | null;
  rpd_used: number;
  rpd_limit: number | null;
  tpd_used: number;
  tpd_limit: number | null;
  cooldown: boolean;
  degraded: boolean;
  failures: number;
  /** The provider's circuit state, or null without breakers. */
  circuit: string | null;
}

export interface ProviderRouter {
  ask(prompt: string, request?: ProviderRequest, ctx?: Record<string, unknown>): Promise<unknown>;
  /** Les entrées sont indexées par "providerId:modelId". */
  getStats(): Record<string, ProviderStats>;
  stop(): void;
  breakers: BreakerPool | null;
}

export function createProviderRouter(config?: ProviderRouterConfig): ProviderRouter;

export interface ToolDefinition<TParams = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  type: string;
  roles: string[];
  /** Reaches outside (web search, third-party API): its parameters are masked. */
  external?: boolean;
  params?: Record<string, unknown>;
  handler(params: TParams, ctx: Record<string, unknown>): Awaitable<TResult>;
}

export interface RegisteredTool<TParams = Record<string, unknown>, TResult = unknown> extends ToolDefinition<TParams, TResult> {
  params: Record<string, unknown>;
}

export interface ToolRegistry {
  register<TParams = Record<string, unknown>, TResult = unknown>(tool: ToolDefinition<TParams, TResult>): ToolDefinition<TParams, TResult>;
  getToolsForRole(role: string): RegisteredTool[];
  getToolByName(name: string): RegisteredTool | null;
  formatToolsForPrompt(role: string): string;
}

export function createToolRegistry(): ToolRegistry;

export interface AgentMessage {
  role?: string;
  content?: string;
}

export interface AgentRouter {
  ask(prompt: string, request?: ProviderRequest, ctx?: Record<string, unknown>): Awaitable<string | AsyncIterable<unknown> | null | undefined>;
}

export interface ToolCall {
  name: string;
  params: Record<string, unknown>;
}

export interface AgentLoopOptions {
  prompt: string;
  ctx?: Record<string, unknown>;
  history?: Array<string | AgentMessage>;
  registry: ToolRegistry;
  router: AgentRouter;
  userRole: string;
  maxSteps?: number;
  /**
   * Called with each text chunk as it arrives, when router.ask() returns a
   * stream — real token-by-token passthrough to your UI. The loop still
   * needs the fully-assembled text to detect a tool call, so it keeps
   * accumulating internally regardless of whether you pass this.
   */
  onChunk?: (chunk: string) => void;
  /**
   * Awaited before a detected tool call actually executes. Return (or
   * resolve to) false to deny — the loop tells the model the call was not
   * approved and continues, rather than crashing. Omit to auto-execute
   * every allowed tool call, unchanged from before.
   */
  confirmTool?: (toolCall: ToolCall, ctx: Record<string, unknown>) => Awaitable<boolean>;
  /**
   * Masks what leaves for the model, unmasks what comes back. Tools marked
   * `external: true` receive masked parameters.
   */
  masker?: ReversibleMasker;
  /** A throwing tool becomes { error: 'tool_failed' | 'tool_timeout' } for the model. Default false (throws). */
  reportToolErrors?: boolean;
  toolTimeoutMs?: number;
  /** Time budget for the whole loop. */
  maxMs?: number;
  /** When steps or time run out: one last turn without tools, with this instruction. */
  finalInstruction?: string;
  now?: () => number;
}

export function runAgentLoop(options: AgentLoopOptions): Promise<string>;

export type ActionStatus = 'proposed' | 'approved' | 'rejected' | 'executing' | 'executed' | 'failed';

export interface PendingAction {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  description: string | null;
  proposedBy: unknown;
  tenant: unknown;
  dedupeKey: string | null;
  status: ActionStatus;
  proposedAt: Date;
  approvedBy?: unknown;
  approvedAt?: Date;
  rejectedBy?: unknown;
  rejectedAt?: Date;
  executedAt?: Date;
  failedAt?: Date;
  lastError?: string;
  amendedWith?: Record<string, unknown> | null;
  reviewNote?: string | null;
  [key: string]: unknown;
}

export interface ActionStore {
  create(data: Record<string, unknown>): Awaitable<PendingAction>;
  find(id: string): Awaitable<PendingAction | null>;
  /** Atomic status transition: returns null when the record was not in `from`. */
  claim(id: string, from: ActionStatus[], patch: Record<string, unknown>): Awaitable<PendingAction | null>;
  update(id: string, patch: Record<string, unknown>): Awaitable<PendingAction | null>;
  findOpenByKey?(dedupeKey: string, statuses: ActionStatus[]): Awaitable<PendingAction | null>;
  list?(filter?: Record<string, unknown>): Awaitable<PendingAction[]>;
}

export type ActionTool = (
  payload: Record<string, unknown>,
  context: { action: PendingAction; approvedBy: unknown }
) => Awaitable<unknown>;

export interface PendingActions {
  /** The agent proposes a write. Nothing runs yet. */
  propose(input: {
    action: string;
    payload?: Record<string, unknown>;
    description?: string;
    proposedBy?: unknown;
    tenant?: unknown;
    dedupeKey?: string;
  }): Promise<{ created: boolean; action: PendingAction }>;
  /** A human says yes — the tool runs once, atomically claimed. */
  approve(id: string, review: { approvedBy: unknown; amend?: Record<string, unknown> }): Promise<
    | { executed: true; action: PendingAction; result: unknown }
    | { executed: false; reason: 'already-handled' | 'failed'; error?: string }
  >;
  reject(id: string, review: { rejectedBy: unknown; note?: string }): Promise<PendingAction>;
  pending(filter?: Record<string, unknown>): Promise<PendingAction[]>;
  tools: string[];
  OPEN_STATUSES: ActionStatus[];
}

export function createPendingActions(options: {
  store: ActionStore;
  tools: Record<string, ActionTool>;
  onPending?: (action: PendingAction) => Awaitable<void>;
  now?: () => Date;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
}): PendingActions;

export function createMemoryActionStore(): ActionStore & {
  findOpenByKey(dedupeKey: string, statuses: ActionStatus[]): Promise<PendingAction | null>;
  list(filter?: Record<string, unknown>): Promise<PendingAction[]>;
  size(): number;
};

export interface FallbackAnswer {
  handled: boolean;
  answer?: Record<string, unknown> & { degraded?: boolean };
}

export interface DeterministicFallback<Input = Record<string, unknown>> {
  answer(input: Input): Promise<FallbackAnswer>;
  /** Try the provider; serve the deterministic answer when it throws, carrying the provider error. */
  withFallback<T>(ask: (input: Input) => Awaitable<T>, input: Input): Promise<
    | { degraded: false; answer: T }
    | { degraded: true; answer: Record<string, unknown>; providerError: unknown }
  >;
  intents: string[];
}

export function createDeterministicFallback<Input = Record<string, unknown>>(options: {
  responders: Record<string, (input: Input) => Awaitable<unknown>>;
  classify?: (input: Input) => string | null | undefined;
  markDegraded?: (answer: Record<string, unknown>) => Record<string, unknown>;
}): DeterministicFallback<Input>;

/** A literal word (escaped) or a RegExp whose source is used as-is. */
export type VocabularyEntry = string | RegExp;

export interface CleanerVocabulary {
  /** Wrapper keys whose string value IS the answer ({"response": "..."}). */
  payloadKeys?: VocabularyEntry[];
  /** Object keys rendered as a bold heading when JSON becomes prose. */
  titleKeys?: string[];
  /** Labels removed at the start of a line only ("**introduction** : ..."). */
  lineLabels?: VocabularyEntry[];
  /** Form-like labels removed anywhere they are followed by ":", "-" or "—". */
  inlineLabels?: VocabularyEntry[];
  /** Labels removed when alone on a line or leading one, bold or not, colon or not. */
  headingLabels?: VocabularyEntry[];
  reasoningLabels?: VocabularyEntry[];
  reasoningStarters?: VocabularyEntry[];
  finalMarkers?: VocabularyEntry[];
  planningStarters?: VocabularyEntry[];
  leadingFillers?: VocabularyEntry[];
  annotationMarkers?: VocabularyEntry[];
  /** Robotic closings, removed only at the very end of the reply. */
  closingPhrases?: VocabularyEntry[];
  openers?: VocabularyEntry[];
}

export interface ResponseCleaner {
  clean(text: string | null | undefined, options?: { language?: string }): string;
  jsonToProse(value: unknown, language?: string): string;
  languages: string[];
}

export function createResponseCleaner(options?: {
  shared?: CleanerVocabulary;
  languages?: Record<string, CleanerVocabulary>;
  fallbackLanguage?: string;
  maxClosingPasses?: number;
}): ResponseCleaner;

export interface FormatSurface {
  columns: number;
  narrow?: boolean;
  aliases?: string[];
}

export interface FormatLanguagePack {
  /** Mandatory: the paragraph rule reaches every surface. */
  paragraphs: string;
  heading?: string;
  intro?: string;
  table?: string;
  narrow?: string;
  wide?: string;
  rules?: string[];
  surfaceNames?: Record<string, string>;
}

export interface FormatInstructions {
  build(surface: unknown, language?: string): string;
  normalizeSurface(surface: unknown): string;
  surfaces: string[];
  languages: string[];
}

export const DEFAULT_SURFACES: Record<'phone' | 'tablet' | 'desktop', FormatSurface>;

export function createFormatInstructions(options: {
  languages: Record<string, FormatLanguagePack>;
  surfaces?: Record<string, FormatSurface>;
  defaultSurface?: string;
  fallbackLanguage?: string;
}): FormatInstructions;

/* ─────────────────── Circuits ─────────────────── */

export interface BreakerLike {
  call<T>(fn: () => Awaitable<T>): Promise<T>;
  status?(): { state?: string; [key: string]: unknown };
  reset?(): void;
}

export interface BreakerPool {
  get(key: string): BreakerLike;
  run<T>(key: string, fn: () => Awaitable<T>): Promise<T>;
  status(): Record<string, unknown>;
  stateOf(key: string): string | null;
  reset(key?: string): void;
  keys(): string[];
}

/** Refuses a factory that returns the same breaker for two keys. */
export function createBreakerPool(options: { create: (key: string) => BreakerLike }): BreakerPool;
/** Timeouts, network errors, 408 and 5xx are outages; 429 and other 4xx are not. */
export function isProviderOutage(error: unknown): boolean;
export function isCircuitOpen(error: unknown): boolean;

/* ─────────────────── Outbound masking ─────────────────── */

export interface DetectedEntity {
  text: string;
  type: string;
  score: number;
}

export interface ReversibleMasker {
  mask(text: string, options?: { names?: string[] }): string;
  /** Runs the detector first (keep it local), learns, then masks. */
  maskAsync(text: string, options?: { names?: string[] }): Promise<string>;
  maskDeep<T>(value: T): T;
  unmask(text: string): string;
  unmaskDeep<T>(value: T): T;
  unmaskStream(chunks: AsyncIterable<unknown>): AsyncGenerator<string>;
  detectNames(text: string): Promise<string[]>;
  size(): number;
}

export function createReversibleMasker(options?: {
  names?: string[];
  patterns?: Array<{ type: string; pattern: RegExp }>;
  detect?: (text: string) => Awaitable<DetectedEntity[] | null | undefined>;
  detectTypes?: string[];
  minScore?: number;
  detectMaxChars?: number;
  minLength?: number;
  token?: (type: string, sequence: number) => string;
  typeOf?: (value: string) => string;
  keep?: (value: string) => boolean;
}): ReversibleMasker;

export function withOutboundMasking<Rest extends unknown[], R>(
  masker: ReversibleMasker,
  call: (input: any, ...rest: Rest) => Awaitable<R>
): (input: unknown, ...rest: Rest) => Promise<R>;

export function headWithoutCuttingWords(text: string, max: number): string;

/* ─────────────────── Passages in another language ─────────────────── */

export interface Passage {
  title?: string;
  text: string;
  lang?: string;
  kind?: string;
  ref?: unknown;
  url?: string;
}

export interface PassageTexts {
  header?: string;
  footer?: string;
  /** Required when a passage can be foreign. `{languages}` becomes the tags found. */
  foreign?: string;
  empty?: string;
}

export function primaryLanguage(tag: unknown): string | null;
export function isForeignLanguage(passageLanguage: unknown, readerLanguage: unknown): boolean;
export function markForeignPassages(passages: Passage[], options: { lang: string; tag?: (language: string) => string }): { blocks: string[]; languages: string[] };
/** `passages: null` means the search failed: nothing is said. */
export function buildPassagesContext(options: { passages: Passage[] | null | undefined; lang: string; texts?: PassageTexts; tag?: (language: string) => string }): string[];
export function passageSource(passage: Passage, options?: { excerptMax?: number }): Omit<Passage, 'text'> & { excerpt: string };

/* ─────────────────── Sources ─────────────────── */

export interface SourceLedger<S = Record<string, unknown>> {
  keep(found: S[], data?: unknown): void;
  sources(): S[];
  evidence(): string[];
  size(): number;
}

export function createSourceLedger<S = Record<string, unknown>>(options?: { keyOf?: (source: S) => string }): SourceLedger<S>;

export function usedSources<S extends { url?: string; title?: string }, Place = unknown>(
  answer: string,
  sources: S[],
  evidence?: string[],
  options?: {
    references?: (text: string) => Place[];
    sameReference?: (a: Place, b: Place) => boolean;
    ownReference?: (source: S) => Place | null | undefined;
    commonWords?: Iterable<string>;
    minWordLength?: number;
    sharedMin?: number;
    shortEvidence?: number;
  }
): S[];

export interface NliScores { entailment: number; neutral?: number; contradiction: number }

export function findContradiction(
  answer: string,
  sources: Array<string | { content?: string; snippet?: string; url?: string; source?: string }>,
  options: {
    compare: (pairs: Array<{ premise: string; hypothesis: string }>) => Awaitable<NliScores[] | null>;
    timeoutMs?: number;
    minWords?: number;
    sharedMin?: number;
    maxPairs?: number;
    contradictionMin?: number;
    entailmentMax?: number;
    commonWords?: Iterable<string>;
  }
): Promise<{ contradicts: boolean; sentence: string | null; source: string | null } | null>;

export function factualSentences(answer: string, minWords: number): string[];

export function rerankResults<R, S, F extends { results: R[]; sources?: S[] }>(
  query: string,
  found: F,
  options: {
    score: (query: string, passages: string[]) => Awaitable<number[] | null>;
    passageOf?: (result: R) => string;
    sourceMatches?: (source: S, result: R) => boolean;
  }
): Promise<F>;

/* ─────────────────── Answer text ─────────────────── */

export function plainText(text: unknown): string;
export function tidyMarkdown(text: unknown, options?: { removeEmoji?: boolean }): string;
export function isFaithfulQuotation(quoted: string, source: string): boolean;
export function verifyQuotations<Refs = unknown>(text: string, options: {
  findReferences: (text: string) => Awaitable<Array<{ start: number; end: number; refs: Refs }>>;
  resolve: (refs: Refs) => Awaitable<string | null | undefined>;
}): Promise<string>;

/* ─────────────────── Reply language ─────────────────── */

export interface LanguageDetector {
  byWords(text: string): string | null;
  reply(text: string, appLanguage: string): Promise<string>;
  languages: string[];
}

export function createLanguageDetector(options: {
  words: Record<string, string[]>;
  identify?: (text: string) => Awaitable<{ language: string; confidence: number }>;
  fallback?: string;
  confidenceMin?: number;
  shortConfidenceMin?: number;
  shortWords?: number;
  lead?: number;
  maxChars?: number;
}): LanguageDetector;

/* ─────────────────── Ask limit ─────────────────── */

export interface AskLimitVerdict { allowed: boolean; remaining: number; retryInMs: number }

export interface AskLimit {
  /** Throws a 429 AppError with `code` and `retryInMs` past the limit. */
  take(subject: string | number, now?: number): AskLimitVerdict;
  peek(subject: string | number, now?: number): AskLimitVerdict;
  reset(subject?: string | number): void;
  size(): number;
  sweep(now: number): void;
}

export function createAskLimit(options: { max: number; windowMs: number; code?: string; sweepEvery?: number }): AskLimit;

/* ─────────────────── OpenAI-compatible endpoints ─────────────────── */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text?: string;
  content?: string;
  images?: Array<{ mimeType: string; data: string }>;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  toolCallId?: string;
  result?: unknown;
}

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  /** The model sent arguments that are not a JSON object. */
  invalid?: true;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export function askChatModel(
  target: { url: string; key: string; model: string; extra?: Record<string, unknown> },
  request: { system?: string; messages: ChatMessage[]; tools?: Array<Record<string, unknown>>; maxTokens?: number; temperature?: number },
  io: { fetch: FetchLike; signal?: AbortSignal; timeoutMs?: number }
): Promise<{ status: number; text?: string | null; toolCalls?: ChatToolCall[]; cut?: boolean }>;

export function readToolArguments(raw: unknown): { args: Record<string, unknown> | null; invalid: boolean };

export function createOpenAICompatibleProvider(options: {
  id: string;
  url: string;
  getKey: () => Awaitable<string | null | undefined>;
  models: ProviderModel[];
  fetch: FetchLike;
  external?: boolean;
  timeoutMs?: number;
  extra?: Record<string, unknown>;
  toRequest?: (prompt: string, ctx: Record<string, unknown>) => { system?: string; messages: ChatMessage[] };
}): Provider;
