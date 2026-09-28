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
