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
  /** Faux (sans clé, éteint) : le routeur le saute sans rien lui demander ni compter d'échec. */
  available?(ctx: Record<string, unknown>): Awaitable<boolean>;
  /** Une voie : une clé à elle pour cet usage, qui se repose seule ("fournisseur:modèle@voie"). */
  lane?(ctx: Record<string, unknown>): string | null | undefined;
  call(prompt: any, ctx: Record<string, unknown>, model: ProviderModel): Awaitable<unknown>;
  [key: string]: unknown;
}

/** Un candidat de `request.candidates` : un modèle d'un fournisseur, avec ses champs (extra, vision…). */
export interface RouteCandidate {
  provider: string;
  model: string;
  [field: string]: unknown;
}

export interface ProviderRequest {
  complexity?: string;
  estimatedTokens?: number;
  intent?: string;
  maxTokens?: number;
  /** L'ordre de CETTE demande, à travers les fournisseurs. */
  candidates?: RouteCandidate[];
  /** Ne garde que les modèles aptes à cette demande (une photo : ceux qui voient). */
  select?: (model: ProviderModel, provider: Provider) => boolean;
  /** Faux : la réponse est refusée, le modèle suivant est demandé (ce n'est pas une panne du modèle). */
  accepts?: (value: any) => boolean;
  /** Vrai : réponse coupée, gardée en dernier recours seulement. */
  partial?: (value: any) => boolean;
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
  /** Ce qui met un modèle au repos (cooldownMs). Défaut : un 429. */
  cooldownOn?: (error: any) => boolean;
  /** 'try' : quand tous les candidats se reposent, on les essaie quand même. Défaut 'skip'. */
  whenAllCooling?: 'skip' | 'try';
  /** L'horloge des repos et des quotas. Défaut Date.now. */
  now?: () => number;
}

export interface RouteResult<T = unknown> {
  value: T;
  provider: string;
  model: string;
  /** "fournisseur:modèle", suivi de "@voie" quand le fournisseur en a une pour cet appel. */
  key: string;
  /** La réponse coupée gardée en dernier recours. */
  partial: boolean;
}

/**
 * Levée par ask/route (AppError 503) : `code` vaut 'AI_NO_PROVIDER' (aucun
 * fournisseur disponible), 'AI_NO_MATCH' (aucun ne convient à la demande) ou
 * 'AI_UNAVAILABLE' (tous essayés, aucun n'a répondu ; `errors` les porte).
 * Une demande abandonnée (ctx.signal) lève la raison de l'appelant.
 */
export type RouterErrorCode = 'AI_NO_PROVIDER' | 'AI_NO_MATCH' | 'AI_UNAVAILABLE';

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
  ask(prompt: any, request?: ProviderRequest, ctx?: Record<string, unknown>): Promise<unknown>;
  /** Comme ask, et dit qui a répondu. */
  route(prompt: any, request?: ProviderRequest, ctx?: Record<string, unknown>): Promise<RouteResult>;
  /** Les entrées sont indexées par "providerId:modelId" (et "@voie"). */
  getStats(): Record<string, ProviderStats>;
  /** Oublie repos, dégradations, échecs et usage. */
  reset(): void;
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
  /** Niveau de risque déclaré ; absent, le registre utilise UNKNOWN. */
  risk?: DeclaredToolRisk;
  params?: Record<string, unknown>;
  handler(params: TParams, ctx: Record<string, unknown>): Awaitable<TResult>;
}

export type ToolRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
export type DeclaredToolRisk = Exclude<ToolRisk, 'UNKNOWN'>;
export const TOOL_RISKS: Readonly<Record<ToolRisk, number>>;

export interface RegisteredTool<TParams = Record<string, unknown>, TResult = unknown> extends Omit<ToolDefinition<TParams, TResult>, 'risk'> {
  params: Record<string, unknown>;
  risk: ToolRisk;
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
  /** Seuils d'appels strictement identiques (défauts : 3, 5 et 8). */
  loopGuard?: { reminder?: number; firmReminder?: number; stop?: number };
  /** Mise de côté au-delà du seuil en caractères (défaut : 12 000). */
  spill?: { threshold?: number; store?: SpillStore };
  /** Politique active uniquement lorsqu'elle est fournie : always, never ou seuil de risque. */
  confirmationPolicy?: 'always' | 'never' | { threshold: ToolRisk };
  /** Analyseurs supplémentaires ; le risque le plus élevé prévaut. */
  riskAnalyzers?: Array<(toolCall: ToolCall, ctx: Record<string, unknown>, tool: RegisteredTool) => Awaitable<ToolRisk>>;
  /** Adaptateur de createPendingActions ; les actions créées attendent leur approbation. */
  pendingActions?: Pick<PendingActions, 'propose'>;
  onEvent?: (event: { type: 'tool_loop_warning' | 'tool_loop_stopped'; name: string; repetitions: number; message?: string; reason?: string }) => void;
  now?: () => number;
}

export interface SpillStore {
  set(id: string, value: string): Awaitable<void>;
  get(id: string): Awaitable<string | undefined>;
}
export function createMemorySpillStore(): SpillStore;
export const DEFAULT_LOOP_THRESHOLDS: Readonly<{ reminder: number; firmReminder: number; stop: number }>;
export const DEFAULT_SPILL_THRESHOLD: number;

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
/** `remove` : des expressions globales retirées après les marques (ce que l'app ne montre jamais). */
export function tidyMarkdown(text: unknown, options?: { removeEmoji?: boolean; remove?: RegExp[] }): string;
/** Un texte coupé ramené à sa dernière phrase entière. */
export function wholeSentences(text: unknown, options?: { marks?: string[] }): string;
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
  /** Pourquoi : 'not_json' (illisible) ou 'not_object'. */
  invalidReason?: 'not_json' | 'not_object';
  /** L'erreur de lecture, pour 'not_json'. */
  invalidDetail?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export function askChatModel(
  target: { url: string; key: string; model: string; extra?: Record<string, unknown> },
  request: { system?: string; messages: ChatMessage[]; tools?: Array<Record<string, unknown>>; maxTokens?: number; temperature?: number },
  io: { fetch: FetchLike; signal?: AbortSignal; timeoutMs?: number }
): Promise<{ status: number; text?: string | null; toolCalls?: ChatToolCall[]; cut?: boolean }>;

export function readToolArguments(raw: unknown): { args: Record<string, unknown> | null; invalid: boolean; reason?: 'not_json' | 'not_object'; detail?: string };

/** Les appels d'outil écrits dans un texte (<function=…>, <tool_call>{…}</tool_call>), relus. */
export function readWrittenToolCalls(text: string): Array<{ id: string; name: string; args: Record<string, unknown> }>;
/** Le raisonnement entre balises think retiré, même ouvert sans fin ou fermé sans ouverture. */
export function withoutThinking(content: unknown): string;

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: Array<Record<string, unknown>>;
  maxTokens?: number;
  temperature?: number;
}

/** Ce qu'un fournisseur `detailed` rend au routeur. */
export interface DetailedAnswer {
  text: string | null;
  toolCalls: ChatToolCall[];
  cut: boolean;
}

export interface ChatProviderOptions {
  getKey: (ctx: Record<string, unknown>) => Awaitable<string | null | undefined>;
  models?: ProviderModel[];
  /** `ctx.fetch` le remplace pour un appel. */
  fetch: FetchLike;
  timeoutMs?: number;
  lane?: (ctx: Record<string, unknown>) => string | null | undefined;
  /** Vrai : l'appel rend { text, toolCalls, cut } au lieu du texte seul. */
  detailed?: boolean;
  toRequest?: (prompt: any, ctx: Record<string, unknown>) => ChatRequest;
}

export function createOpenAICompatibleProvider(options: ChatProviderOptions & {
  id: string;
  url: string | ((ctx: Record<string, unknown>) => string | null | undefined);
  external?: boolean;
  extra?: Record<string, unknown>;
}): Provider;

/* ─────────────────── Gemini ─────────────────── */

export function askGeminiModel(
  model: string,
  request: ChatRequest,
  io: { key: string; fetch: FetchLike; signal?: AbortSignal; timeoutMs?: number; endpoint?: string; noSystemInstruction?: (model: string) => boolean }
): Promise<{ status: number; text?: string | null; toolCalls?: ChatToolCall[]; cut?: boolean }>;

export function createGeminiProvider(options: ChatProviderOptions & {
  id?: string;
  endpoint?: string;
  /** Défaut : les modèles Gemma, qui ne prennent pas de consigne système. */
  noSystemInstruction?: (model: string) => boolean;
}): Provider;

/* ─────────────────── Outils natifs et leur boucle ─────────────────── */

export type NativeToolKind = 'read' | 'write' | 'confirm' | string;

export interface NativeToolResult {
  data?: unknown;
  sources?: Array<Record<string, unknown>>;
  card?: Record<string, unknown>;
  undo?: unknown;
  [key: string]: unknown;
}

export interface NativeTool<Ctx = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: { type: 'object'; [key: string]: unknown };
  kind: NativeToolKind;
  summary?: (args: Record<string, unknown>) => Record<string, string | number>;
  run(args: Record<string, unknown>, ctx: Ctx & { signal: AbortSignal }): Awaitable<NativeToolResult | null | undefined>;
  perform?(args: Record<string, unknown>, ctx: Ctx): Awaitable<NativeToolResult | null | undefined>;
  undo?(undo: unknown, ctx: Ctx): Awaitable<unknown>;
}

export const NATIVE_TOOL_KINDS: string[];
export function validateNativeTools<T extends NativeTool<any>>(tools: T[], options?: { kinds?: string[]; requireSummary?: boolean }): T[];
export function toolSpecs(tools: NativeTool<any>[]): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
export function stepParams(tool: NativeTool<any> | null | undefined, args: unknown, options?: { max?: number }): Record<string, string | number>;

export interface NativeToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  invalid?: boolean;
  invalidReason?: 'not_json' | 'not_object';
  invalidDetail?: string;
}

export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  result: unknown;
}

export function createToolCaller<Ctx = Record<string, unknown>>(options: {
  tools: Map<string, NativeTool<Ctx>> | NativeTool<Ctx>[];
  context?: Ctx;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  emit?: (type: 'step' | 'step_done', data: Record<string, unknown>) => void;
  keep?: (sources: unknown, data: unknown) => void;
  record?: (entry: { tool: NativeTool<Ctx>; args: Record<string, unknown> | null; found: NativeToolResult }) => Awaitable<void>;
  onCall?: (stats: { name: string; ms: number; ok: boolean }) => void;
  resultMax?: number;
  messages?: {
    unknownTool?: (name: string) => string;
    timeout?: () => string;
    invalidArguments?: (call: { name: string; invalidReason?: string; invalidDetail?: string }) => string;
    waiting?: string;
  };
}): (call: NativeToolCall) => Promise<ToolMessage>;

export interface ToolTurn {
  text: string | null;
  toolCalls: NativeToolCall[];
  model?: string;
}

/** Lève une AppError de code 'AI_NO_ANSWER' quand un tour ne donne ni texte ni outil. */
export function runToolLoop(options: {
  system: string;
  messages: Array<ChatMessage | ToolMessage | Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  turn: (request: { system: string; messages: any[]; tools: Array<Record<string, unknown>> }) => Awaitable<ToolTurn>;
  callTool: (call: NativeToolCall) => Promise<ToolMessage>;
  maxTurns?: number;
  maxMs?: number;
  finalInstruction?: string;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<{ text: string; turns: number }>;

/* ─────────────────── Flux d'évènements (SSE) ─────────────────── */

export const EVENT_STREAM_HEADERS: Record<string, string>;
export function openEventStream(
  res: { statusCode: number; setHeader(name: string, value: string): unknown; flushHeaders(): void; write(chunk: string): unknown; end(): unknown; on(event: 'close', listener: () => void): unknown; writableEnded: boolean },
  options?: { headers?: Record<string, string> }
): { send(type: string, data: unknown): void; close(): void; signal: AbortSignal };

/* ─────────────────── Recherche web ─────────────────── */

export interface WebResult { title: string; url: string; snippet: string; date: string | null }

/** Lève une erreur de code 'WEB_SEARCH_NO_KEY' (rien n'est demandé) ou 'WEB_SEARCH_FAILED'. */
export function searchSerper(
  search: { query: string; sites?: string[]; hl?: string; num?: number },
  io: { key: string | null | undefined; fetch: FetchLike; accept?: (result: WebResult, url: URL) => boolean; timeoutMs?: number; endpoint?: string }
): Promise<WebResult[]>;

// Serveur llama.cpp (inférence CPU) : src/llamaCpp.js
export const DEFAULT_LLAMA_CPP_URL: string;
export function normalizeLlamaCppUrl(value: string): string;

export interface LlamaCppConfigInput {
  /** Base du serveur, avec ou sans `/v1` (défaut http://127.0.0.1:8080). */
  baseUrl?: string;
  apiKey?: string | null;
  model?: string | null;
  timeoutMs?: number;
  healthTimeoutMs?: number;
}
export interface LlamaCppConfig {
  readonly id: 'llama.cpp';
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly model: string | null;
  readonly timeoutMs: number;
  readonly healthTimeoutMs: number;
}
export function createLlamaCppConfig(input?: LlamaCppConfigInput): LlamaCppConfig;

export type LocalLlmErrorCode = 'UNREACHABLE' | 'TIMEOUT' | 'UNAUTHORIZED' | 'LOADING' | 'HTTP_ERROR' | 'INVALID_RESPONSE';
export class LocalLlmError extends Error {
  code: LocalLlmErrorCode;
  status: number | null;
}

export interface LlamaCppChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; [key: string]: unknown }
export interface LlamaCppChatOptions { model?: string; temperature?: number; max_tokens?: number; [key: string]: unknown }
export interface LlamaCppChatResult {
  text: string;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  model: string | null;
}
export interface LlamaCppHealthState {
  ok: boolean;
  status: 'ok' | 'loading' | 'unauthorized' | 'error' | 'unreachable' | 'timeout';
  latencyMs: number;
  httpStatus?: number;
  message?: string;
}
export interface LlamaCppProvider {
  config: LlamaCppConfig;
  health(): Promise<LlamaCppHealthState>;
  waitUntilReady(options?: { timeoutMs?: number; intervalMs?: number }): Promise<LlamaCppHealthState>;
  listModels(): Promise<Array<{ id: string; ownedBy: string | null }>>;
  chat(messages: LlamaCppChatMessage[], options?: LlamaCppChatOptions): Promise<LlamaCppChatResult>;
  chatStream(messages: LlamaCppChatMessage[], options?: LlamaCppChatOptions): AsyncGenerator<string, void, undefined>;
  toOpenAICompatible(): { baseURL: string; apiKey: string; model: string | null };
}
export function createLlamaCppProvider(options?: LlamaCppConfigInput & {
  fetch?: (url: string, init: object) => Awaitable<Response>;
  sleep?: (ms: number) => Promise<void>;
}): LlamaCppProvider;
