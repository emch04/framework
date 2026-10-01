export type Awaitable<T> = T | Promise<T>;

export type ModelsEndpoint = 'embed' | 'rerank' | 'nli' | 'entities' | 'transcribe';

export type ModelsResultCode =
  | 'invalid_input'
  | 'payload_too_large'
  | 'unauthorized'
  | 'not_found'
  | 'model_not_configured'
  | 'model_unavailable'
  | 'busy'
  | 'memory_limit'
  | 'unavailable'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'bad_response'
  | 'circuit_open'
  | 'model_mismatch'
  | 'aborted';

/** Never thrown: every method resolves to this on failure, so callers degrade. */
export interface ModelsFailure {
  ok: false;
  code: ModelsResultCode;
  endpoint: ModelsEndpoint | 'health';
  /** True for codes worth another try later (network, 5xx, busy). */
  retryable: boolean;
  status?: number;
  /** The server's message on a refusal — never contains the texts sent. */
  message?: string;
  retryInMs?: number;
  /** On `model_mismatch`: what the server used, and what was expected. */
  model?: string;
  expected?: string;
}

export type ModelsResult<T> = ({ ok: true } & T) | ModelsFailure;

export interface EmbedData {
  vectors: number[][];
  /** Id of the model that produced the vectors: never compare vectors of two ids. */
  model: string;
  dimensions: number;
}

export interface RerankData { scores: number[]; model: string | null }

export interface NliScores { entailment: number; neutral: number; contradiction: number }
export interface NliData { results: NliScores[]; model: string | null }

export interface Entity { text: string; label: string; start: number; end: number; score: number }
export interface EntitiesData { entities: Entity[]; model: string | null }

export interface TranscribeData {
  /** Empty for silence — an answer, not a failure. */
  text: string;
  language: string;
  avgLogprob: number;
  noSpeechProb: number;
  durationMs: number;
  audioMs: number;
  model: string | null;
}

export interface ModelStatus { configured: boolean; loaded: boolean; failed: boolean; model: string | null }
export interface HealthData { version: string | null; models: Record<string, ModelStatus> }

export interface CallOptions {
  timeoutMs?: number;
  /** Total tries for this call, first included. */
  attempts?: number;
  signal?: AbortSignal;
}

export interface TranscribeOptions extends CallOptions {
  /** ISO code, `'auto'` or null/undefined for detection. */
  language?: string | null;
  /** Expected vocabulary (names, product terms), at most `transcribeMaxPromptChars`. */
  prompt?: string;
  /** Voice activity filter, when the server allows it. */
  vad?: boolean;
}

/** Same shape as `createCircuitBreaker` of @astratra/resilience. */
export interface ModelsBreaker {
  call<T>(fn: () => Awaitable<T>): Promise<T>;
  isOpen?(): boolean;
  status?(): unknown;
  reset?(): void;
}

export type ModelsEvent =
  | { type: 'retry'; endpoint: string; code: ModelsResultCode; attempt: number; delayMs: number }
  | { type: 'failure'; endpoint: string; code: ModelsResultCode; status?: number }
  | { type: 'circuit_open'; endpoint: string }
  | { type: 'breaker'; endpoint: string; from: string; to: string };

export interface ModelsLimits {
  embedMaxBatch: number;
  embedMaxChars: number;
  rerankMaxDocuments: number;
  rerankMaxChars: number;
  nliMaxPairs: number;
  nliMaxChars: number;
  entitiesMaxChars: number;
  entitiesMaxLabels: number;
  entitiesMaxLabelChars: number;
  transcribeMinSeconds: number;
  transcribeMaxSeconds: number;
  transcribeMaxPromptChars: number;
}

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface ModelsClientOptions {
  /** Default http://127.0.0.1:5007. */
  baseUrl?: string;
  /** Default globalThis.fetch. */
  fetch?: FetchLike;
  /** A string, or a function read before every request (rotated keys). */
  token?: string | (() => Awaitable<string | null | undefined>);
  timeouts?: Partial<Record<ModelsEndpoint | 'health', number>>;
  retry?: {
    attempts?: number | Partial<Record<ModelsEndpoint | 'health', number>>;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Also retry timeouts (doubles the worst-case latency). Default false. */
    retryTimeouts?: boolean;
  };
  /** Built-in breaker settings, or false for none. Default 3 failures, 60 s. */
  breaker?: false | { failureThreshold?: number; recoveryMs?: number };
  /** Inject a breaker per endpoint, e.g. createCircuitBreaker of @astratra/resilience. */
  createBreaker?: (endpoint: ModelsEndpoint) => ModelsBreaker;
  limits?: Partial<ModelsLimits>;
  /** Expected embedding model id: any other answers `model_mismatch`. */
  embedModel?: string;
  onEvent?: (event: ModelsEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface ModelsClient {
  embed(texts: string[], options?: CallOptions): Promise<ModelsResult<EmbedData>>;
  rerank(query: string, documents: string[], options?: CallOptions): Promise<ModelsResult<RerankData>>;
  nli(pairs: Array<{ premise: string; hypothesis: string }>, options?: CallOptions): Promise<ModelsResult<NliData>>;
  entities(text: string, labels?: string[] | null, options?: CallOptions): Promise<ModelsResult<EntitiesData>>;
  entities(text: string, options: CallOptions): Promise<ModelsResult<EntitiesData>>;
  /** `audio`: PCM 16-bit little-endian mono 16 kHz, as bytes or base64. */
  transcribe(audio: Uint8Array | string, options?: TranscribeOptions): Promise<ModelsResult<TranscribeData>>;
  /** Bypasses the breakers. */
  health(options?: CallOptions): Promise<ModelsResult<HealthData>>;
  /** False while the endpoint's breaker refuses calls. */
  available(endpoint: ModelsEndpoint): boolean;
  breakerStatus(endpoint: ModelsEndpoint): unknown;
  resetBreakers(): void;
  /** `embed` function for @astratra/memory: `{ vector, source: modelId }`, throws on failure. */
  asMemoryEmbed(options?: CallOptions): (text: string) => Promise<{ vector: number[]; source: string }>;
}

export function createModelsClient(options?: ModelsClientOptions): ModelsClient;

export const ENDPOINTS: readonly ModelsEndpoint[];
export const DEFAULT_TIMEOUTS: Readonly<Record<ModelsEndpoint | 'health', number>>;
export const DEFAULT_ATTEMPTS: Readonly<Record<ModelsEndpoint | 'health', number>>;
export const DEFAULT_LIMITS: Readonly<ModelsLimits>;
export const RESULT_CODES: readonly ModelsResultCode[];

export class ModelsCircuitOpenError extends Error {
  code: 'CIRCUIT_OPEN';
  retryInMs: number;
}

export interface EndpointBreaker extends ModelsBreaker {
  isOpen(): boolean;
  status(): { name: string; state: 'closed' | 'open' | 'half-open'; failures: number; openedAt: number | null };
  reset(): void;
}

export function createEndpointBreaker(options?: {
  name?: string;
  /** Default 3. */
  failureThreshold?: number;
  /** Default 60 000. */
  recoveryMs?: number;
  now?: () => number;
  onStateChange?: (change: { name: string; from: string; to: string }) => void;
}): EndpointBreaker;

/* ---- deployment ---------------------------------------------------------- */

export interface ServerPaths { dir: string; app: string; backends: string; requirements: string; setupScript: string }
export function serverPaths(): ServerPaths;

export interface ServiceEnvOptions {
  modelsDir?: string;
  host?: string;
  port?: number;
  enabled?: ModelsEndpoint[];
  threads?: number;
  configFile?: string;
  tokenFile?: string;
  maxRssMb?: number;
  /** Extra MODELS_* variables. MODELS_TOKEN is refused: pass tokenFile. */
  env?: Record<string, string | number | boolean>;
}

export function serviceEnv(options?: ServiceEnvOptions): Record<string, string>;

export interface Pm2App {
  name: string;
  script: string;
  interpreter: string;
  cwd: string;
  exec_mode: 'fork';
  instances: 1;
  autorestart: true;
  max_restarts: number;
  restart_delay: number;
  kill_timeout: number;
  max_memory_restart?: string;
  env: Record<string, string>;
}

export function createPm2App(options: ServiceEnvOptions & {
  /** Interpreter of the service's virtual environment (absolute). */
  python: string;
  name?: string;
  script?: string;
  cwd?: string;
  /** e.g. "4G": pm2 restarts the process above it. */
  maxMemoryRestart?: string;
  maxRestarts?: number;
  restartDelay?: number;
  killTimeout?: number;
}): Pm2App;

export function renderPm2Ecosystem(apps: Pm2App | Pm2App[]): string;

export function createSystemdUnit(options: ServiceEnvOptions & {
  python: string;
  user: string;
  group?: string;
  script?: string;
  workingDirectory?: string;
  description?: string;
  /** Hard memory ceiling of the cgroup, e.g. "6G". */
  memoryMax?: string;
  memoryHigh?: string;
  /** e.g. "400%" for four cores. */
  cpuQuota?: string;
  restartSec?: number;
  environmentFile?: string;
  readWritePaths?: string[];
}): string;

export function setupVenvCommand(options: {
  venvDir: string;
  components?: Array<'onnx' | 'entities' | 'transcribe'>;
  python?: string;
}): string[];

/* ---- model prices -------------------------------------------------------- */

/** Unit prices in USD: per token, except `image` (per generated image) and `second` (per audio second). */
export type PriceName =
  | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h'
  | 'audioInput' | 'audioOutput' | 'reasoning' | 'image' | 'second';
export type UnitPrices = Partial<Record<PriceName, number>>;

export type UsageField =
  | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h'
  | 'audioInput' | 'audioOutput' | 'reasoning' | 'images' | 'seconds';
/** Disjoint counts: a token appears in one field only. */
export type CanonicalUsage = Record<UsageField, number>;

/** Canonical counts, or the usage object of OpenAI (chat or Responses), Anthropic, Gemini or the AI SDK. */
export type UsageInput = Partial<CanonicalUsage> | Record<string, unknown>;

export type Billing = 'paid' | 'free' | 'free_tier' | 'credits';
export type MatchedBy = 'exact' | 'alias' | 'provider_prefix' | 'provider_suffix' | 'override';
export type PriceResultCode = 'unknown_model' | 'invalid_usage' | 'no_price';

export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  toolChoice: boolean;
  audioInput: boolean;
  audioOutput: boolean;
  reasoning: boolean;
  promptCaching: boolean;
  responseSchema: boolean;
  pdfInput: boolean;
  webSearch: boolean;
}

export interface ContextWindow { maxInput: number | null; maxOutput: number | null }

export interface PriceTier {
  name: string;
  /** Long-context surcharge: applies when the prompt is above this many tokens. */
  above?: number;
  /** tiered_pricing range [min, max) of prompt tokens. */
  range?: [number, number];
  prices: UnitPrices;
}

export interface PriceFailure {
  ok: false;
  code: PriceResultCode;
  model: string;
  message: string;
  key?: string;
  /** On `no_price`: usage fields with no price at all. */
  missing?: UsageField[];
}

export interface ModelPriceInfo {
  ok: true;
  model: string;
  key: string;
  provider: string | null;
  mode: string | null;
  matchedBy: MatchedBy;
  source: 'catalog' | 'override' | 'catalog+override';
  billing: Billing;
  /** Effective prices (overrides applied). */
  prices: UnitPrices;
  /** Catalog prices, before any override. */
  listPrices: UnitPrices;
  tiers: PriceTier[];
  contextWindow: ContextWindow;
  capabilities: ModelCapabilities;
  deprecationDate: string | null;
  catalogDate: string | null;
  creditPool?: string;
  note?: string;
}

/** Frozen snapshot: never changes once computed, whatever happens to the catalog. */
export interface CallCost {
  ok: true;
  model: string;
  key: string;
  provider: string | null;
  matchedBy: MatchedBy;
  source: 'catalog' | 'override' | 'catalog+override';
  currency: 'USD';
  billing: Billing;
  /** What is billed (0 for free and free tier). */
  total: number;
  /** What the catalog says the call is worth, or null when it has no price. */
  listTotal: number | null;
  breakdown: Partial<Record<UsageField, number>>;
  unitPrices: Partial<Record<UsageField, { price: PriceName; perUnit: number }>>;
  tier: string | null;
  usage: CanonicalUsage;
  catalogDate: string | null;
  computedAt: string;
  creditPool?: string;
}

export interface PriceOverride {
  /** Exact model id (any accepted spelling) — or use `match`. */
  model?: string;
  /** Pattern on the requested id or the catalog key: a RegExp, or a string with an optional (?i) prefix. */
  match?: RegExp | string;
  /** Catalog id to borrow prices, window and capabilities from. */
  as?: string;
  prices?: UnitPrices;
  pricesPerMillion?: UnitPrices;
  /** Fraction off every catalog price not set in `prices`, e.g. 0.2. */
  discount?: number;
  /** Default 'paid'. */
  billing?: Billing;
  /** Required with billing 'credits'. */
  creditPool?: string;
  contextWindow?: Partial<ContextWindow>;
  capabilities?: Partial<ModelCapabilities>;
  provider?: string;
  mode?: string;
  note?: string;
}

export interface LookupOptions {
  /** Provider the call went to (e.g. 'groq', 'gemini', 'google', 'vercel'): scopes the search to it. */
  provider?: string;
}

export interface CostOptions extends LookupOptions {
  /** Bill a 'free_tier' model at its price (the free quota is used up). */
  freeTierExhausted?: boolean;
}

export type LiteLLMCatalog = Record<string, Record<string, unknown>>;

export interface PriceCatalog {
  lookup(model: string, options?: LookupOptions): ModelPriceInfo | PriceFailure;
  cost(model: string, usage: UsageInput, options?: CostOptions): CallCost | PriceFailure;
  contextWindow(model: string, options?: LookupOptions): ({ ok: true; model: string; key: string } & ContextWindow) | PriceFailure;
  capabilities(model: string, options?: LookupOptions): ({ ok: true; model: string; key: string } & ModelCapabilities) | PriceFailure;
  readonly date: string | null;
  readonly size: number;
}

export function createPriceCatalog(options?: {
  /** LiteLLM-format catalog. Default: the bundled dated copy. */
  data?: LiteLLMCatalog;
  date?: string | null;
  /** Object keyed by model id, or an array (first match wins). Throws TypeError when invalid. */
  overrides?: Record<string, Omit<PriceOverride, 'model'>> | PriceOverride[];
  aliases?: Record<string, string> | Array<{ from: string; model: string } | { match: RegExp | string; model: string }>;
  now?: () => number;
}): PriceCatalog;

export function loadBundledCatalog(): { data: LiteLLMCatalog; date: string; file: string };
export function bundledCatalogFile(dir?: string): { file: string; date: string } | null;
/** Vendor usage -> canonical disjoint counts, or null when not recognised. */
export function normalizeUsage(usage: unknown): CanonicalUsage | null;
export function diffPriceCatalogs(before: LiteLLMCatalog, after: LiteLLMCatalog): {
  added: string[];
  removed: string[];
  changed: Array<{ key: string; field: string; before: unknown; after: unknown }>;
};

export const PRICE_NAMES: readonly PriceName[];
export const USAGE_FIELDS: readonly UsageField[];
export const BILLINGS: readonly Billing[];
export const COST_CODES: readonly PriceResultCode[];
export const PROVIDER_ALIASES: Readonly<Record<string, string>>;
export const CATALOG_URL: string;
