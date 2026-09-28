const { chunkText, createEmbedder, createMemoryVectorStore, assertVectorStoreContract, fuseByRank, createHybridSearch, verifySources, createIndexer } = require('../src');
const fakeEmbed = (texts) => Promise.resolve(texts.map((text) => /alpha|first/i.test(text) ? [1, 0] : [0, 1]));

test('paragraph groups stay intact and overlap carries the previous group', () => {
  const chunks = chunkText([{ text: 'First alpha.', group: 'a' }, { text: 'Second alpha.', group: 'a' }, { text: 'Third beta.', group: 'b' }], { maxLength: 31, overlap: 1 });
  expect(chunks).toEqual(['First alpha.\n\nSecond alpha.', 'Third beta.']);
  expect(chunkText([{ text: 'One.', group: 'a' }, { text: 'Two.', group: 'b' }, { text: 'Three.', group: 'c' }], { maxLength: 14, overlap: 1 })).toEqual(['One.\n\nTwo.', 'Two.\n\nThree.']);
});

test('long paragraphs split and retain all content', () => {
  const chunks = chunkText('Alpha sentence. Beta sentence. Gamma sentence.', { maxLength: 20, overlap: 0 });
  expect(chunks.join(' ')).toBe('Alpha sentence. Beta sentence. Gamma sentence.');
  expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
});

test('embedder batches, tags model and masks outside queries', async () => {
  const embed = jest.fn(fakeEmbed);
  const maskQuery = jest.fn(() => '[MASK] alpha');
  const embedder = createEmbedder({ modelId: 'space-a', embed, batchSize: 2, external: true, maskText: maskQuery });
  expect((await embedder.embedTexts(['a', 'b', 'c'])).vectors).toHaveLength(3);
  expect(embed).toHaveBeenCalledTimes(2);
  await embedder.embedTexts(['Private alpha'], { kind: 'query' });
  expect(embed.mock.calls[2][0]).toEqual(['[MASK] alpha']);
  expect(maskQuery).toHaveBeenCalledWith('Private alpha', { kind: 'query', modelId: 'space-a' });
  expect(await createEmbedder({ modelId: 'remote', embed, external: true }).embedTexts(['secret'], { kind: 'query' })).toBeNull();
});

test('memory store fulfills exported contract', async () => {
  await assertVectorStoreContract(createMemoryVectorStore);
});

test('mixed embedding spaces refuse vector search while keyword remains available', async () => {
  const store = createMemoryVectorStore();
  await store.replaceSource('s', 'v1', [{ id: 'a', sourceId: 's', text: 'alpha', vector: [1, 0], modelId: 'other' }]);
  const search = createHybridSearch({ store, embedder: createEmbedder({ modelId: 'mine', embed: fakeEmbed }) });
  expect(await search('alpha')).toMatchObject({ code: 'EMBEDDING_SPACE_MISMATCH', results: [{ id: 'a' }] });
});

test('rank fusion rewards agreement and reranker is off by default', async () => {
  expect(fuseByRank([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }]])[0].id).toBe('b');
  const store = createMemoryVectorStore();
  await store.replaceSource('s', 'v1', [
    { id: 'a', sourceId: 's', text: 'alpha', vector: [1, 0], modelId: 'm' },
    { id: 'b', sourceId: 's', text: 'beta', vector: [0, 1], modelId: 'm' }
  ]);
  const rerank = jest.fn(async () => [0, 1]);
  const search = createHybridSearch({ store, embedder: createEmbedder({ modelId: 'm', embed: fakeEmbed }), rerank });
  expect((await search('alpha')).results[0].id).toBe('a');
  expect(rerank).not.toHaveBeenCalled();
  expect((await search('alpha', { rerankBudgetMs: 50 })).results[0].id).toBe('b');
});

test('slow or failing reranker falls back to fused order', async () => {
  const store = createMemoryVectorStore();
  await store.replaceSource('s', 'v1', [{ id: 'a', sourceId: 's', text: 'alpha', vector: [1, 0], modelId: 'm' }]);
  const search = createHybridSearch({ store, rerank: () => new Promise(() => {}) });
  expect((await search('alpha', { rerankBudgetMs: 1 })).results[0].id).toBe('a');
  const failing = createHybridSearch({ store, rerank: async () => { throw new Error('offline'); } });
  expect((await failing('alpha', { rerankBudgetMs: 5 })).results[0].id).toBe('a');
});

test('source verification flags contradictions and unsupported claims', async () => {
  const nli = jest.fn(async (pairs) => pairs.map(() => ({ entailment: 0.1, contradiction: 0.9 })));
  const result = await verifySources('Alpha is blue. Gamma is yellow.', [{ text: 'Alpha is red.', source: 'one' }], { nli });
  expect(result).toMatchObject({ code: 'OK', flags: [
    { code: 'CONTRADICTION', claim: 'Alpha is blue.', source: 'one' },
    { code: 'UNSUPPORTED_CLAIM', claim: 'Gamma is yellow.', source: null }
  ] });
  expect(nli).toHaveBeenCalledTimes(1);
  expect(await verifySources('Alpha is blue.', ['Alpha is red.'])).toMatchObject({ code: 'NLI_UNAVAILABLE', flags: [] });
});

test('indexer is incremental, full pass removes missing sources, lock can skip', async () => {
  const store = createMemoryVectorStore();
  let sources = [{ id: 's', version: 'v1', text: 'First alpha.' }];
  const embed = jest.fn(fakeEmbed);
  const indexer = createIndexer({ store, embedder: createEmbedder({ modelId: 'm', embed }), sources: { list: async () => sources } });
  expect(await indexer.run({ full: true })).toMatchObject({ code: 'OK', added: 1 });
  expect(await indexer.run({ full: false })).toMatchObject({ code: 'OK', added: 0 });
  expect(embed).toHaveBeenCalledTimes(1);
  const nextModel = createIndexer({ store, embedder: createEmbedder({ modelId: 'm2', embed }), sources: { list: async () => sources } });
  expect(await nextModel.run()).toMatchObject({ added: 1 });
  expect((await store.searchVector([1, 0], 'm2')).code).toBe('OK');
  sources = [];
  expect(await indexer.run({ full: true })).toMatchObject({ removed: 1 });
  expect(await store.listSourceIds()).toEqual([]);
  const locked = createIndexer({ store, embedder: createEmbedder({ modelId: 'm', embed }), sources: { list: async () => sources }, lock: { run: async () => null } });
  expect((await locked.run()).code).toBe('SKIPPED');
});

test('watch schedules full then short and stops cleanly with injected timers', async () => {
  let current = 0;
  const scheduled = [];
  const calls = [];
  const store = createMemoryVectorStore();
  const indexer = createIndexer({ store, embedder: createEmbedder({ modelId: 'm', embed: fakeEmbed }), sources: { list: async ({ full }) => { calls.push(full); return []; } }, now: () => current, setTimer: (fn, ms) => { scheduled.push({ fn, ms }); return fn; }, clearTimer: jest.fn() });
  const watcher = indexer.watch({ shortEveryMs: 10, fullEveryMs: 30 });
  await new Promise((resolve) => setImmediate(resolve));
  expect(calls).toEqual([true]);
  expect(scheduled[0].ms).toBe(10);
  current = 10;
  scheduled.shift().fn();
  await new Promise((resolve) => setImmediate(resolve));
  expect(calls).toEqual([true, false]);
  await watcher.stop();
});
