export type Kind = 'query' | 'passage';
export interface Block { kind: 'heading' | 'question' | 'paragraph'; text: string; number?: number; group?: string | number; together?: Array<{ text: string; number?: number }> }
export interface NormalizedDocument { id: string; version: string | null; title: string; format: string; metadata: Record<string, unknown>; blocks: Block[] }
export interface Chunk { id: string; text: string; contentHash: string; numbers: number[]; context: string }
export interface ChunkOptions { maxLength?: number; minLength?: number; overlap?: number; context?: string; sourceId?: string }
export function contentHash(value: unknown): string;
export function htmlBlocks(input: string): Block[];
export function markdownBlocks(input: string): Block[];
export function textBlocks(input: string): Block[];
export function normalizeDocument(input: { id: string; version?: string; title?: string; content?: string; text?: string; format?: string; metadata?: Record<string, unknown> }, options?: { extractors?: Record<string, (text: string, input: unknown) => Block[]>; format?: string }): NormalizedDocument;
export function sentencesOf(text: string): string[];
export function chunkBlocks(input: string | Array<string | Block>, options?: ChunkOptions): Chunk[];
export function chunkText(input: string | Array<string | Block>, options?: ChunkOptions): string[];
export function createLocalEmbedder(options: { modelId: string; load: () => Promise<((texts: string[], options: { kind: Kind; modelId: string }) => Promise<number[][]>) | { embed(texts: string[], options: { kind: Kind; modelId: string }): Promise<number[][]> }>; prefixes?: Partial<Record<Kind, string>> }): { modelId: string; embed(texts: string[], options?: { kind?: Kind }): Promise<number[][]> };
export interface Embedder { modelId: string; embedTexts(texts: string[], options?: { kind?: Kind }): Promise<{ modelId: string; vectors: number[][] } | null>; limits?: { batchSize: number; maxBatchCharacters: number } }
export function batches(texts: string[], maxTexts: number, maxCharacters: number): string[][];
export function createEmbedder(options: { modelId: string; embed: (texts: string[], context: { kind: Kind; modelId: string }) => Promise<number[][]>; batchSize?: number; maxBatchCharacters?: number; maxTextLength?: number; prefixes?: Partial<Record<Kind, string>>; external?: boolean; maskText?: (text: string, context: { kind: Kind; modelId: string }) => string | Promise<string>; maskQuery?: (text: string, context: { kind: Kind; modelId: string }) => string | Promise<string> }): Embedder;
export class EmbedderUnavailableError extends Error { code: 'EMBEDDER_UNAVAILABLE'; fatal: true }
export function createRemoteEmbedder(options: { url: string; modelId: string; fetch: (url: string, options: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>; maskText?: (text: string, context: { kind: Kind; modelId: string }) => string | Promise<string>; external?: boolean; headers?: Record<string, string>; timeoutMs?: number; retries?: number; retryDelayMs?: number; maxRetryDelayMs?: number; jitter?: number; random?: () => number; delay?: (ms: number) => Promise<void>; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void; createAbortController?: () => AbortController; maxTexts?: number; maxTextLength?: number; circuitBreaker?: { call<T>(fn: () => Promise<T>): Promise<T>; isOpen?(): boolean }; logger?: { warn(value: { code: 'REMOTE_RETRY'; attempt: number; retryInMs: number; reason?: string }): void } }): { modelId: string; embed(texts: string[], options: { kind: Kind }): Promise<number[][]> };
export interface RemoteEmbedderError extends Error { fatal?: true; retryable?: false; status?: number; code?: 'MODEL_MISMATCH' | 'INVALID_VECTORS'; expected?: string; received?: string | null }
export interface Document { id: string; sourceId: string; documentId?: string; version?: string; title?: string; text: string; context?: string; modelId: string; vector: number[]; similarity?: number; keywordScore?: number; metadata?: Record<string, unknown>; [key: string]: unknown }
export interface VectorResult { code: 'OK' | 'EMBEDDING_SPACE_MISMATCH'; results: Document[] }
export type Filter = ((document: Document) => boolean) | Record<string, unknown>;
export interface VectorStore {
  getSourceVersion(sourceId: string): Promise<string | null>;
  listSourceIds(): Promise<string[]>;
  removeSource(sourceId: string): Promise<number>;
  searchKeyword(query: string, options?: { limit?: number; filter?: Filter }): Promise<Document[]>;
  searchVector(vector: number[], modelId: string, options?: { limit?: number; filter?: Filter; minSimilarity?: number }): Promise<VectorResult>;
  /** Simple protocol: a source replaced as a whole (read back with its vectors to reuse them). */
  replaceSource?(sourceId: string, version: string, documents: Document[]): Promise<void>;
  getSourceDocuments?(sourceId: string): Promise<Document[]>;
  /** Incremental protocol: with the three first, the indexer writes slice by slice and never loads stored vectors. */
  listSourceChunkIds?(sourceId: string, modelId: string): Promise<string[]>;
  putDocuments?(sourceId: string, documents: Document[]): Promise<void>;
  commitSource?(sourceId: string, version: string, keepIds: string[]): Promise<{ removed: number }>;
  /** Notes the version of a source that could not be read, keeping its documents; true when it did, so the source is not read again until it changes. */
  noteSourceFailure?(sourceId: string, version: string, error: unknown): Promise<boolean>;
}
export function tokenize(text: string): string[];
export function cosine(a: number[], b: number[]): number | null;
export type MemoryVectorStore = Required<VectorStore>;
export function createMemoryVectorStore(options?: { titleWeight?: number; contextWeight?: number; k1?: number; b?: number }): MemoryVectorStore;
export function assertVectorStoreContract(factory: () => VectorStore | Promise<VectorStore>): Promise<void>;
export function runStoreContract(factory: () => VectorStore | Promise<VectorStore>, runner?: { describe?: (name: string, fn: () => void) => void; test?: (name: string, fn: () => Promise<void>) => void; expect?: (value: unknown) => unknown }): void;
export function fuseByRank<T extends { id: string }>(lists: T[][], k?: number, weights?: number[]): Array<T & { score: number }>;
export interface RerankOutcome { status: 'disabled' | 'mask_required' | 'timeout' | 'invalid' | 'failed' | 'applied'; scores: number[] | null }
export type Reranker = (query: string, candidates: Document[], budgetMs: number) => Promise<RerankOutcome>;
export function createReranker(options: { score: (query: string, texts: string[]) => Promise<number[]>; maxCandidates?: number; maxTextLength?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void; logger?: { warn(value: unknown): void }; external?: boolean; maskText?: (text: string, context: { kind: Kind }) => string | Promise<string> }): Reranker;
export interface SearchOptions { limit?: number; reach?: number; filter?: Filter; alsoIn?: Array<{ filter: Filter; weight?: number; keyword?: boolean }>; rerankBudgetMs?: number; rerankMode?: 'replace' | 'fuse'; minSimilarity?: number; perDocument?: number; perDocumentReranked?: number; minRerankScore?: number }
export function createHybridSearch(options: { store: VectorStore; embedder?: Embedder; rerank?: (query: string, texts: string[]) => Promise<number[]>; reranker?: Reranker; rrfK?: number; weights?: number[]; ties?: 'keyword' | 'vector'; logger?: { warn(value: unknown): void }; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void }): (query: string, options?: SearchOptions) => Promise<{ code: string; results: Array<Document & { score: number; rerankScore?: number }>; rerank: RerankOutcome['status'] }>;
export interface ClaimAssessment { category: 'SUPPORTED' | 'CONTRADICTED' | 'UNSUPPORTED'; claim: string; source: string | null }
export interface VerificationFlag { code: 'CONTRADICTION' | 'UNSUPPORTED_CLAIM'; claim: string; source: string | null }
export function factualClaims(answer: string): string[];
export function verifySources(answer: string, sources: Array<string | { text?: string; content?: string; source?: string; url?: string }>, options?: { nli?: (pairs: Array<{ premise: string; hypothesis: string }>) => Promise<Array<{ entailment: number; contradiction: number }> | null>; maxPairs?: number; minOverlap?: number; contradictionThreshold?: number; supportThreshold?: number }): Promise<{ code: 'OK' | 'NLI_UNAVAILABLE'; claims: ClaimAssessment[]; flags: VerificationFlag[] }>;
export interface IndexPassage { id?: string; text: string; context?: string; title?: string; numbers?: number[]; contentHash?: string; metadata?: Record<string, unknown> }
export interface IndexSource { id: string; version?: string; fingerprint?: string | number; title?: string; text?: string; content?: string; format?: string; metadata?: Record<string, unknown>; chunkOptions?: ChunkOptions; chunks?: IndexPassage[]; read?: () => Promise<Partial<IndexSource>> }
export interface JobLock { run<T>(name: string, holdMs: number, fn: () => Promise<T>): Promise<T | null> }
export interface IndexStats { code: 'OK' | 'SKIPPED'; added: number; removed: number; kept: number; sources: number; unchanged: number; failed: number; parked: number; remaining: boolean; ms: number }
export function createIndexer(options: { sources: { list(options: { full: boolean }): Promise<IndexSource[] | AsyncIterable<IndexSource>> | AsyncIterable<IndexSource> }; store: VectorStore | (() => VectorStore); embedder: Embedder | (() => Embedder); chunk?: (blocks: Block[], options?: ChunkOptions) => Chunk[]; extractors?: Record<string, (text: string, input: unknown) => Block[]>; lock?: JobLock; lockName?: string; lockHoldMs?: number; maxPassages?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void; logger?: { warn(value: unknown): void } }): {
  run(options?: { full?: boolean; maxPassages?: number }): Promise<IndexStats>;
  watch(options?: { shortEveryMs?: number; fullEveryMs?: number; pauseAfterFailureMs?: number; onRun?: (stats: IndexStats, pass: { full: boolean }) => void; onError?: (error: unknown) => void }): { stop(): Promise<void> };
};

type Awaitable<T> = T | Promise<T>;
// Extraction de documents par un service Docling : src/extraction
export type ExtractionErrorCode = 'UNREACHABLE' | 'TIMEOUT' | 'UNAUTHORIZED' | 'UNSUPPORTED_FILE' | 'FILE_TOO_LARGE' | 'CONVERSION_FAILED' | 'HTTP_ERROR' | 'INVALID_RESPONSE';
export class ExtractionError extends Error {
  code: ExtractionErrorCode;
  status: number | null;
  details: unknown;
}

export const MEDIA_TYPES: Readonly<Record<string, string>>;

export interface TableGrid {
  rows: string[][];
  numRows: number;
  numCols: number;
  /** Nombre de lignes d'en-tête. */
  headerRows: number;
  page: number | null;
}
export function extractTables(documentJson: unknown): TableGrid[];
export function gridFromTable(table: unknown): TableGrid;
export function tableToMarkdown(table: Pick<TableGrid, 'rows' | 'headerRows'>): string;

export type OutputFormat = 'md' | 'json' | 'text' | 'html';
export interface ConvertOptions {
  /** Reconnaissance de caractères (documents numérisés). */
  ocr?: boolean;
  ocrEngine?: string;
  ocrLang?: string | string[];
  tableMode?: 'fast' | 'accurate';
  pdfBackend?: string;
  includeImages?: boolean;
}
export interface ExtractionResult {
  status: string;
  processingTimeMs: number | null;
  warnings: unknown[];
  markdown: string | null;
  json: unknown;
  text: string | null;
  html: string | null;
  tables: TableGrid[];
}
export interface DoclingClient {
  convert(request: {
    file: Uint8Array | string;
    filename?: string;
    formats?: OutputFormat[];
    options?: ConvertOptions;
    /** Passe par la file de tâches du service (gros documents). */
    async?: boolean;
  }): Promise<ExtractionResult>;
  health(): Promise<{ ok: boolean; status: 'ok' | 'unauthorized' | 'error' | 'unreachable' | 'timeout' }>;
}
export function createDoclingClient(options?: {
  baseUrl?: string;
  apiKey?: string | null;
  timeoutMs?: number;
  maxFileBytes?: number;
  pollIntervalMs?: number;
  fetch?: (url: string, init: object) => Awaitable<Response>;
  sleep?: (ms: number) => Promise<void>;
}): DoclingClient;
