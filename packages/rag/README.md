# @astratra/rag

CommonJS retrieval primitives for Node 20+. Providers, fetch, masking, persistence, clocks, timers, locks, logging, and model loaders are injected. The package has no database or model dependency.

## Documents and chunks

`normalizeDocument(input, { extractors })` converts `text`, `html`, or `markdown` content to ordered heading, question, and paragraph blocks. Built-in cleanup removes scripts, navigation, markup, and common entities; override any format with an injected extractor. A source can supply a custom format only with an extractor. `chunkBlocks(blocks, options)` keeps headings and questions with subsequent paragraphs, holds a `together` array of covered paragraphs in one unit when it fits, packs within `maxLength`, removes chunks under `minLength`, and repeats `overlap` preceding units. Long paragraphs split at sentence boundaries before word boundaries. Every chunk has a stable hash-based ID, context, and paragraph numbers. `chunkText` returns the texts only.

```js
const { normalizeDocument, chunkBlocks } = require('@astratra/rag');
const document = normalizeDocument({ id: 'guide-1', format: 'markdown', content: '# Setup\n\nConnect the device.' });
const chunks = chunkBlocks(document.blocks, { sourceId: document.id, minLength: 1 });
```

## Embedding and transport

`createEmbedder({ modelId, embed, batchSize, maxBatchCharacters, maxTextLength, prefixes, external, maskText })` batches by count and total characters, validates dimensions, and returns `{ modelId, vectors }`. Query and passage prefixes are separate. An external embedder requires a masking callback before text reaches its provider; without one, `embedTexts` returns `null` and search falls back to keywords. `createLocalEmbedder({ modelId, load, prefixes })` loads an injected model lazily and retries loading after a failure. No model or tokenizer is bundled.

`createRemoteEmbedder({ url, modelId, fetch, maskText, ... })` supplies an `embed` function for `createEmbedder`. It uses injected fetch, headers, timeout, bounded retries with exponential jitter, delay, and optional `circuitBreaker.call(fn)` / `isOpen()`. The remote response must echo the requested model ID. It never logs query or passage text. Its own masking hook runs before fetch, so callers wrapping it in `createEmbedder` can leave `external` unset to avoid masking twice. Configure the receiving route and its authentication in the application.

```js
const remote = createRemoteEmbedder({
  url: endpoint, modelId: modelVersion, fetch: fetchImpl,
  headers: makeHeaders(), maskText: redact
});
const embedder = createEmbedder({ modelId: remote.modelId, embed: remote.embed });
```

## Store and search

A store implements `replaceSource`, `getSourceVersion`, `listSourceIds`, `getSourceDocuments`, `removeSource`, `searchKeyword`, and `searchVector`. `replaceSource` must validate and atomically replace one source. `searchVector` refuses the entire candidate set when the requested model ID or vector dimension differs. `createMemoryVectorStore()` is the reference implementation; its keyword search uses BM25-style term frequency, inverse document frequency, field weights, and accent folding. Adapters can provide their own ranked keyword results. `runStoreContract(makeStore)` registers adapter tests with Jest-compatible `describe`, `test`, and `expect`; `assertVectorStoreContract` provides a short async check.

`createHybridSearch({ store, embedder, weights, reranker })` runs keyword and vector retrieval, then weighted reciprocal rank fusion. It deduplicates IDs, applies `minSimilarity` to vector candidates and `perDocument` after ranking. `createReranker({ score, external, maskText })` is off unless the search call supplies `rerankBudgetMs > 0`. It limits candidate text, applies masking before an outside scorer, enforces a time budget, and reports `applied`, `timeout`, `failed`, `invalid`, `mask_required`, or `disabled` in the search result. Failure keeps the fused order. An applied reranker orders candidates by its score and can apply `minRerankScore`.

Both retrieval methods receive the same `filter`; adapters must apply it before returning rows. The package does not define user, tenant, or visibility policy. Query masking happens before any outside embedder or reranker call. Return codes are intended for an application-owned message catalog.

## Indexing and watch

`createIndexer({ sources, store, embedder, ... })` accepts `sources.list({ full })`, which can yield sources or lazy `read()` entries. A short pass processes only returned sources. A full pass additionally removes sources missing from that exhaustive listing. Each source is normalized, chunked, compared with stored chunks, and embedded only where its stable chunk ID is new. Its incremental version combines the supplied version, content hash, and embedding model ID, so a model change forces re-embedding. A failed source retains its previous rows. Results include `added`, `removed`, `kept`, `sources`, `unchanged`, `failed`, and elapsed `ms`.

`watch({ shortEveryMs, fullEveryMs, pauseAfterFailureMs })` runs a full pass immediately, then short passes until the next full deadline. It uses injected `now`, `setTimer`, and `clearTimer`, serializes passes, and `stop()` waits for the active pass. An optional `lock.run(name, holdMs, fn)` matches the `@astratra/resilience` job-lock shape. Pick a hold duration longer than a pass, or supply a renewing lock. The application owns the process, source discovery, DB adapter, migrations, endpoint, and CLI.

```js
const store = createMemoryVectorStore();
const indexer = createIndexer({ store, embedder, sources: { list: listSources }, lock });
await indexer.run({ full: true });
const watcher = indexer.watch({ shortEveryMs: 30_000, fullEveryMs: 600_000 });
await watcher.stop();
```

## Source verification

`verifySources(answer, excerpts, { nli })` pairs each factual claim with its closest excerpt and calls injected NLI with `{ premise, hypothesis }`. Its `claims` contain `SUPPORTED`, `CONTRADICTED`, or `UNSUPPORTED`; `flags` contain only actionable contradiction and unsupported codes. Missing, failing, or malformed NLI returns `NLI_UNAVAILABLE` without claiming verification. The application decides how to display these codes.
