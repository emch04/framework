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

`createRemoteEmbedder({ url, modelId, fetch, maskText, ... })` supplies an `embed` function for `createEmbedder`. It uses injected fetch, headers, timeout, bounded retries with exponential jitter (`maxRetryDelayMs` caps the pause, `jitter: 0` with a cap holds it fixed), delay, and optional `circuitBreaker.call(fn)` / `isOpen()`. The remote response must echo the requested model ID, as `modelId` or `model`. It never logs query or passage text; its retry log carries the attempt, the pause and a short reason. Its own masking hook runs before fetch, so callers wrapping it in `createEmbedder` can leave `external` unset to avoid masking twice. A service on the same machine or network takes `external: false`: no masking hook is required and texts are sent as they are. Errors that no other source of the same run could avoid (service unreachable after every try, refusal, wrong model, malformed vectors) carry `fatal: true`; a refusal also carries `status`, a wrong model `code: 'MODEL_MISMATCH'` with `expected` and `received`. `createEmbedder` exposes its batch caps as `limits`, which an indexer follows. Configure the receiving route and its authentication in the application.

```js
const remote = createRemoteEmbedder({
  url: endpoint, modelId: modelVersion, fetch: fetchImpl,
  headers: makeHeaders(), maskText: redact
});
const embedder = createEmbedder({ modelId: remote.modelId, embed: remote.embed });
```

## Store and search

A store implements `getSourceVersion`, `listSourceIds`, `removeSource`, `searchKeyword`, and `searchVector`, plus one of two write protocols. Simple: `replaceSource` validates and atomically replaces one source, and `getSourceDocuments` reads it back with its vectors. Incremental: `listSourceChunkIds(sourceId, modelId)` lists the IDs held for a model (no vectors), `putDocuments(sourceId, documents)` adds embedded documents and leaves the rest alone, and `commitSource(sourceId, version, keepIds)` leaves the source holding the documents named by `keepIds` only, records the version and returns `{ removed }`. An incremental store never has its stored vectors loaded and keeps what a stopped run already wrote; a store that also has `noteSourceFailure(sourceId, version, error)` can park a source that cannot be read (see indexing). A persistent store owns its own table layout, registries and IDs: search results may be named differently from the IDs the indexer writes. `searchVector` refuses the entire candidate set when the requested model ID or vector dimension differs. `createMemoryVectorStore()` is the reference implementation; its keyword search uses BM25-style term frequency, inverse document frequency, field weights, and accent folding. Adapters can provide their own ranked keyword results, and their own policy when a store holds vectors of several models during a re-embedding: comparing only the rows of the requested model is a legitimate one, the reference store refuses the whole set. `runStoreContract(makeStore)` registers adapter tests with Jest-compatible `describe`, `test`, and `expect` (the incremental ones only run on a store that has that protocol); `assertVectorStoreContract` provides a short async check.

`createHybridSearch({ store, embedder, weights, reranker })` runs keyword and vector retrieval, then weighted reciprocal rank fusion. It deduplicates IDs, applies `minSimilarity` to vector candidates and `perDocument` after ranking. `createReranker({ score, external, maskText })` is off unless the search call supplies `rerankBudgetMs > 0`. It limits candidate text, applies masking before an outside scorer, enforces a time budget, and reports `applied`, `timeout`, `failed`, `invalid`, `mask_required`, or `disabled` in the search result. Failure keeps the fused order. An applied reranker orders candidates by its score and can apply `minRerankScore`.

Both retrieval methods receive the same `filter`; adapters must apply it before returning rows. The search never calls it: it is a function for the reference store, and any description (`{ lang, userId, kinds }`) for a SQL store that turns it into a `WHERE`. The package does not define user, tenant, or visibility policy.

Search options beyond the basics: `alsoIn: [{ filter, weight, keyword }]` reads other scopes (the other language of a corpus, a neighbouring collection) as lists of their own in the fusion, by meaning and, with `keyword`, by words. `ties: 'vector'` puts the vector list first on equal scores (keyword by default). `rerankMode: 'fuse'` makes the reranker's order one more list of the fusion instead of replacing the order, keeps only the candidates it read and those at or above `minRerankScore`, and keeps its raw score as `rerankScore`. `perDocumentReranked` caps passages per document only when the reranker was applied (with `perDocument: Infinity`, the fused list stands as it is otherwise). Query masking happens before any outside embedder or reranker call. Return codes are intended for an application-owned message catalog.

## Indexing and watch

`createIndexer({ sources, store, embedder, ... })` accepts `sources.list({ full })`, which can yield sources or lazy `read()` entries. A short pass processes only returned sources. A full pass additionally removes sources missing from that exhaustive listing. Each source is normalized, chunked, compared with stored chunks, and embedded only where its stable chunk ID is new; passages to embed go shortest first, in slices of the embedder's batch, and an incremental store has each slice written as it is computed. Its incremental version combines the supplied version, content hash, and embedding model ID, so a model change forces re-embedding. A failed source retains its previous rows. Results include `added`, `removed`, `kept`, `sources`, `unchanged`, `failed`, `parked`, `remaining`, and elapsed `ms`.

A source can give `fingerprint` (a file's size and date, a row's revision): when the store already holds `<fingerprint>:<modelId>` as its version, the source is counted `unchanged` without calling `read()`. A source can give `chunks` (`{ id, text, context, title, numbers, contentHash, metadata }`) when the application cuts its own passages: they skip normalization and chunking, `title` and `metadata` are per passage and land on the document, and `id` is the passage's identity, so it must change with its content (without one it is named by the content). A source that cannot be read and has a fingerprint is passed to `store.noteSourceFailure` when the store has it: its rows stay, it counts in `failed` and `parked`, and it is not read again until its fingerprint changes. An error marked `fatal` (or `EMBEDDER_UNAVAILABLE`) ends the whole run and is rethrown, since every other source would fail the same way; any other error only fails its source. `maxPassages` (option or per `run`) stops starting new sources once that many passages were embedded: `remaining: true` says some were left, and they are never taken for gone by the full pass. `store` and `embedder` can be functions, called at the start of every run. A failed source is reported to `logger.warn` as `SOURCE_INDEX_FAILED` with its `sourceId` and a short `reason` (the error message, never the source's text).

`watch({ shortEveryMs, fullEveryMs, pauseAfterFailureMs, onRun, onError })` runs a full pass immediately, then short passes until the next full deadline; a full pass stopped at its bound does not count as done. It pauses after a thrown run or a failed source that was not parked. `onRun(stats, { full })` and `onError(error)` report every pass. It uses injected `now`, `setTimer`, and `clearTimer`, serializes passes, and `stop()` waits for the active pass. An optional `lock.run(name, holdMs, fn)` matches the `@astratra/resilience` job-lock shape. Pick a hold duration longer than a pass, or supply a renewing lock. The application owns the process, source discovery, DB adapter, migrations, endpoint, and CLI.

```js
const store = createMemoryVectorStore();
const indexer = createIndexer({ store, embedder, sources: { list: listSources }, lock });
await indexer.run({ full: true });
const watcher = indexer.watch({ shortEveryMs: 30_000, fullEveryMs: 600_000 });
await watcher.stop();
```

## Source verification

`verifySources(answer, excerpts, { nli })` pairs each factual claim with its closest excerpt and calls injected NLI with `{ premise, hypothesis }`. Its `claims` contain `SUPPORTED`, `CONTRADICTED`, or `UNSUPPORTED`; `flags` contain only actionable contradiction and unsupported codes. Missing, failing, or malformed NLI returns `NLI_UNAVAILABLE` without claiming verification. The application decides how to display these codes.
