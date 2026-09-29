const { createMemoryVectorStore, createEmbedder, createHybridSearch, createReranker } = require('../src');
const model = (id = 'm') => createEmbedder({ modelId: id, embed: async (texts) => texts.map(() => [1, 0]) });
async function fixture() {
  const store = createMemoryVectorStore();
  await store.replaceSource('one', 'v1', [
    { id: 'a', sourceId: 'one', documentId: 'one', title: 'Alpha', text: 'first alpha passage', modelId: 'm', vector: [1, 0] },
    { id: 'b', sourceId: 'one', documentId: 'one', text: 'another alpha passage', modelId: 'm', vector: [0.8, 0.2] },
    { id: 'c', sourceId: 'one', documentId: 'one', text: 'alpha extra passage', modelId: 'm', vector: [0.7, 0.3] }
  ]);
  await store.replaceSource('two', 'v1', [{ id: 'd', sourceId: 'two', documentId: 'two', text: 'other passage', modelId: 'm', vector: [0, 1] }]);
  return store;
}
test('empty query returns empty result without embedding', async () => { const embedder = { embedTexts: jest.fn() }; expect(await createHybridSearch({ store: await fixture(), embedder })(' ')).toMatchObject({ results: [] }); expect(embedder.embedTexts).not.toHaveBeenCalled(); });
test('keyword and vector results are fused without duplicate ids', async () => { const result = await createHybridSearch({ store: await fixture(), embedder: model() })('alpha'); expect(new Set(result.results.map((r) => r.id)).size).toBe(result.results.length); expect(result.results[0].id).toBe('a'); });
test('minimum similarity excludes weak vector-only match', async () => { const result = await createHybridSearch({ store: await fixture(), embedder: model() })('unmatched', { minSimilarity: 0.99 }); expect(result.results.map((r) => r.id)).toEqual(['a']); });
test('per-document cap applies after ranking', async () => { const result = await createHybridSearch({ store: await fixture(), embedder: model() })('alpha', { perDocument: 1 }); expect(result.results.filter((r) => r.documentId === 'one')).toHaveLength(1); });
test('filter applies to both retrieval lists', async () => { const result = await createHybridSearch({ store: await fixture(), embedder: model() })('alpha', { filter: (doc) => doc.sourceId === 'two' }); expect(result.results.map((r) => r.id)).toEqual(['d']); });
test('embedding model mismatch keeps keyword result and code', async () => { const result = await createHybridSearch({ store: await fixture(), embedder: model('other') })('alpha'); expect(result.code).toBe('EMBEDDING_SPACE_MISMATCH'); expect(result.results.length).toBeGreaterThan(0); });
test('outside embedder without masker degrades to keywords', async () => { const embedder = createEmbedder({ modelId: 'remote', external: true, embed: jest.fn() }); const result = await createHybridSearch({ store: await fixture(), embedder })('alpha'); expect(result.code).toBe('QUERY_MASK_REQUIRED'); expect(result.results[0].id).toBe('a'); });
test('reranker reorders and can filter by minimum score', async () => { const reranker = createReranker({ score: async (_q, passages) => passages.map((p) => p.includes('other') ? 0.9 : 0.1) }); const result = await createHybridSearch({ store: await fixture(), reranker })('alpha', { rerankBudgetMs: 50, minRerankScore: 0.5 }); expect(result.rerank).toBe('applied'); expect(result.results.every((r) => r.rerankScore >= 0.5)).toBe(true); });
test('timeout is visible and keeps fused order', async () => { const result = await createHybridSearch({ store: await fixture(), reranker: createReranker({ score: () => new Promise(() => {}) }) })('alpha', { rerankBudgetMs: 1 }); expect(result.rerank).toBe('timeout'); expect(result.results[0].id).toBe('a'); });
test('vector provider error degrades to keyword results', async () => { const embedder = { embedTexts: async () => { throw Error('offline'); } }; const result = await createHybridSearch({ store: await fixture(), embedder })('alpha'); expect(result.code).toBe('VECTOR_UNAVAILABLE'); expect(result.results.length).toBeGreaterThan(0); });
const scope = (store) => ({ ...store, searchKeyword: (query, options) => store.searchKeyword(query, { ...options, filter: options.filter && ((doc) => doc.sourceId === options.filter.source) }), searchVector: (vector, id, options) => store.searchVector(vector, id, { ...options, filter: options.filter && ((doc) => doc.sourceId === options.filter.source) }) });
test('a filter that is not a function goes to the store untouched', async () => { const store = await fixture(); const seen = []; const spy = { ...store, searchKeyword: async (q, o) => { seen.push(o.filter); return store.searchKeyword(q, {}); }, searchVector: async (v, m, o) => { seen.push(o.filter); return store.searchVector(v, m, {}); } }; await createHybridSearch({ store: spy, embedder: model() })('alpha', { filter: { lang: 'fr' } }); expect(seen).toEqual([{ lang: 'fr' }, { lang: 'fr' }]); });
test('another scope is read as a list of its own and its passages come after the first scope at like rank', async () => {
  const store = scope(await fixture()); const search = createHybridSearch({ store, embedder: model() });
  const own = await search('alpha', { filter: { source: 'one' }, limit: 10, perDocument: 10 });
  expect(own.results.map((r) => r.id)).not.toContain('d');
  const wide = await search('alpha', { filter: { source: 'one' }, alsoIn: [{ filter: { source: 'two' } }], limit: 10, perDocument: 10 });
  expect(wide.results.map((r) => r.id)).toContain('d');
  const keywordToo = await createHybridSearch({ store, embedder: model() })('other', { filter: { source: 'one' }, alsoIn: [{ filter: { source: 'two' }, keyword: true, weight: 3 }], limit: 10, perDocument: 10 });
  expect(keywordToo.results[0].id).toBe('d');
});
test('without an embedder the other scope is still read by words when asked', async () => { const result = await createHybridSearch({ store: scope(await fixture()) })('other', { filter: { source: 'one' }, alsoIn: [{ filter: { source: 'two' }, keyword: true }] }); expect(result.results.map((r) => r.id)).toEqual(['d']); });
test('on equal scores the list named by ties comes first', async () => {
  const store = { searchKeyword: async () => [{ id: 'w' }], searchVector: async () => ({ code: 'OK', results: [{ id: 'v' }] }) }; const embedder = { embedTexts: async () => ({ modelId: 'm', vectors: [[1]] }) };
  expect((await createHybridSearch({ store, embedder })('x')).results.map((r) => r.id)).toEqual(['w', 'v']);
  expect((await createHybridSearch({ store, embedder, ties: 'vector' })('x')).results.map((r) => r.id)).toEqual(['v', 'w']);
  expect(() => createHybridSearch({ store, ties: 'other' })).toThrow('INVALID_TIES');
});
test('a reranker read as one more list of the fusion keeps its raw score and drops what it did not read or scored low', async () => {
  const store = await fixture(); const scores = { a: 0.9, b: 0.1, c: 0.6 }; const reranker = async (_q, candidates) => ({ status: 'applied', scores: candidates.map((doc) => scores[doc.id] ?? 0.05) });
  const search = createHybridSearch({ store, embedder: model(), reranker });
  const fuse = await search('alpha', { rerankBudgetMs: 10, rerankMode: 'fuse', minRerankScore: 0.5, limit: 10, perDocument: 10 });
  expect(fuse.rerank).toBe('applied'); expect(fuse.results.map((r) => r.id)).toEqual(['a', 'c']); expect(fuse.results.map((r) => r.rerankScore)).toEqual([0.9, 0.6]);
  expect(fuse.results[0].score).toBeGreaterThan(0);
  const few = await search('alpha', { reach: 1, rerankBudgetMs: 10, rerankMode: 'fuse', limit: 10, perDocument: 10 });
  expect(few.results.map((r) => r.id)).toEqual(['a']);
  await expect(search('alpha', { rerankMode: 'other' })).rejects.toThrow('INVALID_RERANK_MODE');
});
test('the cap per document can apply only once the reranker has judged, the fused list standing as it is without it', async () => {
  const store = await fixture(); const applied = async (_q, candidates) => ({ status: 'applied', scores: candidates.map(() => 0.9) });
  const capped = createHybridSearch({ store, embedder: model(), reranker: applied });
  const options = { perDocument: Infinity, perDocumentReranked: 1, limit: 10 };
  expect((await capped('alpha', options)).results.filter((r) => r.documentId === 'one')).toHaveLength(3);
  expect((await capped('alpha', { ...options, rerankBudgetMs: 10 })).results.filter((r) => r.documentId === 'one')).toHaveLength(1);
  const failing = createHybridSearch({ store, embedder: model(), reranker: async () => ({ status: 'timeout', scores: null }) });
  expect((await failing('alpha', { ...options, rerankBudgetMs: 10 })).results.filter((r) => r.documentId === 'one')).toHaveLength(3);
});
