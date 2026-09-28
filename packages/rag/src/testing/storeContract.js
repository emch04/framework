function runStoreContract(makeStore, runner = {}) {
  const describe = runner.describe || globalThis.describe;
  const test = runner.test || globalThis.test;
  const expect = runner.expect || globalThis.expect;
  if (![describe, test, expect].every((fn) => typeof fn === 'function')) throw new TypeError('TEST_RUNNER_REQUIRED');
  const row = (id, sourceId = 'a', modelId = 'm') => ({ id, sourceId, modelId, text: `${id} alpha`, title: 'Title', context: 'nearby', vector: [1, 0], metadata: { label: 'safe' } });
  describe('vector store contract', () => {
    test('new store is empty for every read', async () => {
      const store = await makeStore();
      expect(await store.getSourceVersion('a')).toBeNull();
      expect(await store.listSourceIds()).toEqual([]);
      expect(await store.getSourceDocuments('a')).toEqual([]);
      expect(await store.searchKeyword('alpha')).toEqual([]);
      expect(await store.searchVector([1, 0], 'm')).toEqual({ code: 'OK', results: [] });
    });
    test('replaceSource writes version and all documents atomically', async () => {
      const store = await makeStore(); await store.replaceSource('a', 'v1', [row('a1'), row('a2')]);
      expect(await store.getSourceVersion('a')).toBe('v1');
      expect((await store.getSourceDocuments('a')).map((doc) => doc.id)).toEqual(['a1', 'a2']);
      await store.replaceSource('a', 'v2', [row('a3')]);
      expect((await store.getSourceDocuments('a')).map((doc) => doc.id)).toEqual(['a3']);
    });
    test('invalid replacement leaves old source intact', async () => {
      const store = await makeStore(); await store.replaceSource('a', 'v1', [row('a1')]);
      await expect(store.replaceSource('a', 'v2', [row('bad', 'b')])).rejects.toThrow();
      expect(await store.getSourceVersion('a')).toBe('v1');
      expect((await store.getSourceDocuments('a')).map((doc) => doc.id)).toEqual(['a1']);
    });
    test('returned documents are copies', async () => {
      const store = await makeStore(); await store.replaceSource('a', 'v1', [row('a1')]);
      const copy = (await store.getSourceDocuments('a'))[0]; copy.vector[0] = 7; copy.metadata.label = 'changed';
      expect((await store.getSourceDocuments('a'))[0]).toMatchObject({ vector: [1, 0], metadata: { label: 'safe' } });
    });
    test('source replacement and removal isolate other sources', async () => {
      const store = await makeStore(); await store.replaceSource('a', 'v1', [row('a1')]); await store.replaceSource('b', 'v1', [row('b1', 'b')]);
      await store.replaceSource('a', 'v2', []); expect((await store.getSourceDocuments('b')).map((doc) => doc.id)).toEqual(['b1']);
      await store.removeSource('a'); expect(await store.listSourceIds()).toEqual(['b']);
      expect(await store.getSourceVersion('a')).toBeNull();
    });
    test('keyword ranking, limit and filter', async () => {
      const store = await makeStore(); await store.replaceSource('a', 'v1', [row('a1'), { ...row('a2'), text: 'other' }]);
      expect((await store.searchKeyword('alpha', { limit: 1 })).map((doc) => doc.id)).toEqual(['a1']);
      expect((await store.searchKeyword('alpha', { filter: (doc) => doc.id === 'a2' }))).toEqual([]);
    });
    test('vector similarity, threshold, limit and filter', async () => {
      const store = await makeStore(); await store.replaceSource('a', 'v1', [row('a1'), { ...row('a2'), vector: [0, 1] }]);
      expect((await store.searchVector([1, 0], 'm', { limit: 1 })).results.map((doc) => doc.id)).toEqual(['a1']);
      expect((await store.searchVector([1, 0], 'm', { minSimilarity: 0.5 })).results.map((doc) => doc.id)).toEqual(['a1']);
      expect((await store.searchVector([1, 0], 'm', { filter: (doc) => doc.id === 'a2' })).results.map((doc) => doc.id)).toEqual(['a2']);
    });
    test('different model or dimension refuses the entire vector query', async () => {
      const store = await makeStore(); await store.replaceSource('a', 'v1', [row('a1')]); await store.replaceSource('b', 'v1', [row('b1', 'b', 'other')]);
      expect((await store.searchVector([1, 0], 'm')).code).toBe('EMBEDDING_SPACE_MISMATCH');
      expect((await store.searchVector([1], 'm')).code).toBe('EMBEDDING_SPACE_MISMATCH');
    });
    test('invalid documents and queries are rejected', async () => {
      const store = await makeStore();
      await expect(store.replaceSource('a', 'v1', [{ ...row('a1'), vector: [NaN] }])).rejects.toThrow();
      await expect(store.searchVector([NaN], 'm')).rejects.toThrow();
    });
  });
}
module.exports = { runStoreContract };
