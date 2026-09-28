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
export interface Embedder { modelId: string; embedTexts(texts: string[], options?: { kind?: Kind }): Promise<{ modelId: string; vectors: number[][] } | null> }
export function batches(texts: string[], maxTexts: number, maxCharacters: number): string[][];
export function createEmbedder(options: { modelId: string; embed: (texts: string[], context: { kind: Kind; modelId: string }) => Promise<number[][]>; batchSize?: number; maxBatchCharacters?: number; maxTextLength?: number; prefixes?: Partial<Record<Kind, string>>; external?: boolean; maskText?: (text: string, context: { kind: Kind; modelId: string }) => string | Promise<string>; maskQuery?: (text: string, context: { kind: Kind; modelId: string }) => string | Promise<string> }): Embedder;
export class EmbedderUnavailableError extends Error { code: 'EMBEDDER_UNAVAILABLE' }
export function createRemoteEmbedder(options: { url: string; modelId: string; fetch: (url: string, options: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>; maskText: (text: string, context: { kind: Kind; modelId: string }) => string | Promise<string>; headers?: Record<string, string>; timeoutMs?: number; retries?: number; retryDelayMs?: number; jitter?: number; random?: () => number; delay?: (ms: number) => Promise<void>; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void; createAbortController?: () => AbortController; maxTexts?: number; maxTextLength?: number; circuitBreaker?: { call<T>(fn: () => Promise<T>): Promise<T>; isOpen?(): boolean }; logger?: { warn(value: unknown): void } }): { modelId: string; embed(texts: string[], options: { kind: Kind }): Promise<number[][]> };
export interface Document { id: string; sourceId: string; documentId?: string; version?: string; title?: string; text: string; context?: string; modelId: string; vector: number[]; similarity?: number; keywordScore?: number; metadata?: Record<string, unknown>; [key: string]: unknown }
export interface VectorResult { code: 'OK' | 'EMBEDDING_SPACE_MISMATCH'; results: Document[] }
export interface VectorStore {
  replaceSource(sourceId: string, version: string, documents: Document[]): Promise<void>;
  getSourceVersion(sourceId: string): Promise<string | null>;
  listSourceIds(): Promise<string[]>;
  getSourceDocuments(sourceId: string): Promise<Document[]>;
  removeSource(sourceId: string): Promise<number>;
  searchKeyword(query: string, options?: { limit?: number; filter?: (document: Document) => boolean }): Promise<Document[]>;
  searchVector(vector: number[], modelId: string, options?: { limit?: number; filter?: (document: Document) => boolean; minSimilarity?: number }): Promise<VectorResult>;
}
export function tokenize(text: string): string[];
export function cosine(a: number[], b: number[]): number | null;
export function createMemoryVectorStore(options?: { titleWeight?: number; contextWeight?: number; k1?: number; b?: number }): VectorStore;
export function assertVectorStoreContract(factory: () => VectorStore | Promise<VectorStore>): Promise<void>;
export function runStoreContract(factory: () => VectorStore | Promise<VectorStore>, runner?: { describe?: (name: string, fn: () => void) => void; test?: (name: string, fn: () => Promise<void>) => void; expect?: (value: unknown) => unknown }): void;
export function fuseByRank<T extends { id: string }>(lists: T[][], k?: number, weights?: number[]): Array<T & { score: number }>;
export interface RerankOutcome { status: 'disabled' | 'mask_required' | 'timeout' | 'invalid' | 'failed' | 'applied'; scores: number[] | null }
export type Reranker = (query: string, candidates: Document[], budgetMs: number) => Promise<RerankOutcome>;
export function createReranker(options: { score: (query: string, texts: string[]) => Promise<number[]>; maxCandidates?: number; maxTextLength?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void; logger?: { warn(value: unknown): void }; external?: boolean; maskText?: (text: string, context: { kind: Kind }) => string | Promise<string> }): Reranker;
export function createHybridSearch(options: { store: VectorStore; embedder?: Embedder; rerank?: (query: string, texts: Document[]) => Promise<number[]>; reranker?: Reranker; rrfK?: number; weights?: number[]; logger?: { warn(value: unknown): void }; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void }): (query: string, options?: { limit?: number; reach?: number; filter?: (document: Document) => boolean; rerankBudgetMs?: number; minSimilarity?: number; perDocument?: number; minRerankScore?: number }) => Promise<{ code: string; results: Array<Document & { score: number; rerankScore?: number }>; rerank: RerankOutcome['status'] }>;
export interface ClaimAssessment { category: 'SUPPORTED' | 'CONTRADICTED' | 'UNSUPPORTED'; claim: string; source: string | null }
export interface VerificationFlag { code: 'CONTRADICTION' | 'UNSUPPORTED_CLAIM'; claim: string; source: string | null }
export function factualClaims(answer: string): string[];
export function verifySources(answer: string, sources: Array<string | { text?: string; content?: string; source?: string; url?: string }>, options?: { nli?: (pairs: Array<{ premise: string; hypothesis: string }>) => Promise<Array<{ entailment: number; contradiction: number }> | null>; maxPairs?: number; minOverlap?: number; contradictionThreshold?: number; supportThreshold?: number }): Promise<{ code: 'OK' | 'NLI_UNAVAILABLE'; claims: ClaimAssessment[]; flags: VerificationFlag[] }>;
export interface IndexSource { id: string; version?: string; title?: string; text?: string; content?: string; format?: string; metadata?: Record<string, unknown>; chunkOptions?: ChunkOptions; read?: () => Promise<Partial<IndexSource>> }
export interface JobLock { run<T>(name: string, holdMs: number, fn: () => Promise<T>): Promise<T | null> }
export interface IndexStats { code: 'OK' | 'SKIPPED'; added: number; removed: number; kept: number; sources: number; unchanged: number; failed: number; ms: number }
export function createIndexer(options: { sources: { list(options: { full: boolean }): Promise<IndexSource[] | AsyncIterable<IndexSource>> }; store: VectorStore; embedder: Embedder; chunk?: (blocks: Block[], options?: ChunkOptions) => Chunk[]; extractors?: Record<string, (text: string, input: unknown) => Block[]>; lock?: JobLock; lockName?: string; lockHoldMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void; logger?: { warn(value: unknown): void } }): {
  run(options?: { full?: boolean }): Promise<IndexStats>;
  watch(options?: { shortEveryMs?: number; fullEveryMs?: number; pauseAfterFailureMs?: number }): { stop(): Promise<void> };
};
