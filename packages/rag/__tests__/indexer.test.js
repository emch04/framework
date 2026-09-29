const { createMemoryVectorStore, createEmbedder, createIndexer } = require('../src');
const embedder = (id = 'm', spy = jest.fn()) => createEmbedder({ modelId: id, embed: async (texts) => { spy(texts); return texts.map(() => [1, 0]); } });
const source = (id = 'a', text = 'A descriptive paragraph with useful details.') => ({ id, version: 'v1', text });
const setup = (entries = [source()], model = embedder()) => { const store = createMemoryVectorStore(); const indexer = createIndexer({ sources: { list: async () => entries }, store, embedder: model }); return { store, indexer }; };
test('full run stores stable chunk ids and model identity', async () => { const { store, indexer } = setup(); const stats = await indexer.run({ full: true }); expect(stats).toMatchObject({ code: 'OK', added: 1, sources: 1 }); const [doc] = await store.getSourceDocuments('a'); expect(doc.id).toMatch(/^a:[a-f0-9]{64}:0$/); expect(doc.modelId).toBe('m'); });
test('second pass skips unchanged content', async () => { const spy = jest.fn(); const { indexer } = setup([source()], embedder('m', spy)); await indexer.run(); expect(await indexer.run()).toMatchObject({ added: 0, unchanged: 1 }); expect(spy).toHaveBeenCalledTimes(1); });
test('content changes despite stable supplied version force reindex', async () => { const entries = [source()]; const { indexer, store } = setup(entries); await indexer.run(); entries[0] = source('a', 'A changed paragraph with new useful details.'); expect(await indexer.run()).toMatchObject({ added: 1, removed: 1 }); expect((await store.getSourceDocuments('a'))[0].text).toContain('changed'); });
test('model changes force re-embedding', async () => { const entries = [source()]; const { store, indexer } = setup(entries); await indexer.run(); const next = createIndexer({ store, sources: { list: async () => entries }, embedder: embedder('m2') }); expect(await next.run()).toMatchObject({ added: 1 }); expect((await store.getSourceDocuments('a'))[0].modelId).toBe('m2'); });
test('unreadable source keeps previous indexed passages', async () => { const entries = [source()]; const { store, indexer } = setup(entries); await indexer.run(); entries[0] = { id: 'a', read: async () => { throw Error('unreadable'); } }; expect(await indexer.run({ full: true })).toMatchObject({ failed: 1, removed: 0 }); expect(await store.getSourceDocuments('a')).toHaveLength(1); });
test('full run deletes vanished source and short run preserves it', async () => { const entries = [source()]; const { store, indexer } = setup(entries); await indexer.run(); entries.pop(); expect(await indexer.run()).toMatchObject({ removed: 0 }); expect(await store.getSourceDocuments('a')).toHaveLength(1); expect(await indexer.run({ full: true })).toMatchObject({ removed: 1 }); expect(await store.listSourceIds()).toEqual([]); });
test('unchanged chunks can reuse vectors during a partial edit', async () => { const entries = [source('a', 'First distinct paragraph.\n\nSecond distinct paragraph.')]; const spy = jest.fn(); const { indexer } = setup(entries, embedder('m', spy)); await indexer.run(); entries[0] = source('a', 'First distinct paragraph.\n\nThird distinct paragraph.'); await indexer.run(); expect(spy).toHaveBeenCalledTimes(2); expect(spy.mock.calls[1][0]).toHaveLength(1); });
test('lock hook receives compatible run signature', async () => { const lock = { run: jest.fn(async (_name, _hold, fn) => fn()) }; const store = createMemoryVectorStore(); const indexer = createIndexer({ store, embedder: embedder(), sources: { list: async () => [] }, lock, lockName: 'job', lockHoldMs: 9000 }); await indexer.run(); expect(lock.run.mock.calls[0].slice(0, 2)).toEqual(['job', 9000]); });
test('contended lock skips without touching sources', async () => { const list = jest.fn(); const indexer = createIndexer({ store: createMemoryVectorStore(), embedder: embedder(), sources: { list }, lock: { run: async () => null } }); expect((await indexer.run()).code).toBe('SKIPPED'); expect(list).not.toHaveBeenCalled(); });
test('watch immediately runs full pass then short pass, and clears timer on stop', async () => { let current = 0; const timers = []; const clearTimer = jest.fn(); const calls = []; const indexer = createIndexer({ store: createMemoryVectorStore(), embedder: embedder(), sources: { list: async ({ full }) => { calls.push(full); return []; } }, now: () => current, setTimer: (fn, ms) => { timers.push({ fn, ms }); return fn; }, clearTimer }); const watcher = indexer.watch({ shortEveryMs: 10, fullEveryMs: 30 }); await new Promise((r) => setImmediate(r)); expect(calls).toEqual([true]); expect(timers[0].ms).toBe(10); current = 10; timers.shift().fn(); await new Promise((r) => setImmediate(r)); expect(calls).toEqual([true, false]); await watcher.stop(); expect(clearTimer).toHaveBeenCalled(); });
const basicOnly = (store) => ({ replaceSource: (...args) => store.replaceSource(...args), getSourceVersion: (...args) => store.getSourceVersion(...args), listSourceIds: () => store.listSourceIds(), getSourceDocuments: (...args) => store.getSourceDocuments(...args), removeSource: (...args) => store.removeSource(...args) });
const passage = (text, extra = {}) => ({ text, title: `T ${text}`, metadata: { kind: 'k', ref: { n: text } }, ...extra });
const readable = (text) => `T ${text}\n${text}`;
test('passages cut by the application keep their own title, fields and identity, and reuse vectors by id', async () => {
  const spy = jest.fn(); let chunks = [passage('one', { id: 'x:1' }), passage('two', { id: 'x:2' })];
  const { store, indexer } = setup([{ id: 'a', read: async () => ({ chunks }) }], embedder('m', spy));
  expect(await indexer.run({ full: true })).toMatchObject({ added: 2, kept: 0 });
  const docs = await store.getSourceDocuments('a');
  expect(docs.map((doc) => doc.id)).toEqual(['x:1:0', 'x:2:0']);
  expect(docs[0]).toMatchObject({ title: 'T one', kind: 'k', ref: { n: 'one' }, sourceId: 'a', text: 'one' });
  chunks = [chunks[0], passage('three', { id: 'x:3' })];
  expect(await indexer.run()).toMatchObject({ added: 1, kept: 1, removed: 1 });
  expect(spy.mock.calls[1][0]).toEqual([readable('three')]);
});
test('an identity given twice keeps an occurrence number, and a chunk without id is named by its content', async () => {
  const { store, indexer } = setup([{ id: 'a', chunks: [passage('same', { id: 'k' }), passage('same', { id: 'k' }), passage('free')] }]);
  await indexer.run();
  expect((await store.getSourceDocuments('a')).map((doc) => doc.id).sort()).toEqual(expect.arrayContaining(['k:0', 'k:1']));
  expect((await store.getSourceDocuments('a')).find((doc) => doc.text === 'free').id).toMatch(/^a:[a-f0-9]{64}:0$/);
  await expect(setup([{ id: 'b', chunks: [{ nope: 1 }] }]).indexer.run()).resolves.toMatchObject({ failed: 1 });
});
test('a fingerprint known before reading skips the source without reading it, until the fingerprint or the model changes', async () => {
  const read = jest.fn(async () => ({ text: 'A descriptive paragraph with details.' })); const spy = jest.fn();
  let fingerprint = 'size1'; const store = createMemoryVectorStore();
  const make = (id) => createIndexer({ store, embedder: embedder(id, spy), sources: { list: async () => [{ id: 'a', fingerprint, read }] } });
  expect(await make('m').run()).toMatchObject({ added: 1, unchanged: 0 });
  expect(await make('m').run()).toMatchObject({ added: 0, unchanged: 1, sources: 1 });
  expect(read).toHaveBeenCalledTimes(1);
  fingerprint = 'size2'; expect(await make('m').run()).toMatchObject({ added: 0, kept: 1 }); expect(read).toHaveBeenCalledTimes(2);
  expect(await make('m2').run()).toMatchObject({ added: 1 }); expect(read).toHaveBeenCalledTimes(3);
  expect(await store.getSourceVersion('a')).toBe('size2:m2');
});
test('an incremental store is written slice by slice and its stored vectors are never loaded back', async () => {
  const store = createMemoryVectorStore(); const puts = []; const put = store.putDocuments.bind(store);
  store.putDocuments = async (id, docs) => { puts.push(docs.length); return put(id, docs); };
  store.getSourceDocuments = async () => { throw Error('vectors loaded'); };
  const text = Array.from({ length: 7 }, (_, index) => `Paragraph number ${index} of the source.`).join('\n\n');
  const indexer = createIndexer({ store, embedder: createEmbedder({ modelId: 'm', embed: async (t) => t.map(() => [1, 0]), batchSize: 3 }), sources: { list: async () => [{ id: 'a', text, chunkOptions: { maxLength: 60 } }] } });
  expect(await indexer.run()).toMatchObject({ added: 7, removed: 0 });
  expect(puts).toEqual([3, 3, 1]);
  expect(await indexer.run({ full: true })).toMatchObject({ added: 0, unchanged: 1 });
});
test('the same run through a store that only replaces sources gives the same counts', async () => {
  const entries = [source('a', 'First distinct paragraph.\n\nSecond distinct paragraph.')]; const inner = createMemoryVectorStore(); const store = basicOnly(inner);
  const indexer = createIndexer({ store, embedder: embedder(), sources: { list: async () => entries } });
  expect(await indexer.run()).toMatchObject({ added: 1, kept: 0 });
  entries[0] = source('a', 'First distinct paragraph.\n\nThird distinct paragraph.\n\nFourth distinct paragraph.');
  expect(await indexer.run({ full: true })).toMatchObject({ added: 1, removed: 1, kept: 0 });
  expect((await inner.getSourceDocuments('a'))[0].text).toContain('Fourth');
});
test('passages of a slice that was written stay when a later slice fails, and the next run goes on from there', async () => {
  let fail = true; const spy = jest.fn(); const store = createMemoryVectorStore();
  const model = createEmbedder({ modelId: 'm', batchSize: 2, embed: async (texts) => { spy(texts.length); if (fail && spy.mock.calls.length === 2) throw Object.assign(Error('down'), { code: 'EMBEDDER_UNAVAILABLE' }); return texts.map(() => [1, 0]); } });
  const text = Array.from({ length: 5 }, (_, index) => `Paragraph number ${index} of the source.`).join('\n\n');
  const indexer = createIndexer({ store, embedder: model, sources: { list: async () => [{ id: 'a', text, chunkOptions: { maxLength: 60 } }] } });
  await expect(indexer.run()).rejects.toMatchObject({ code: 'EMBEDDER_UNAVAILABLE' });
  expect(await store.getSourceDocuments('a')).toHaveLength(2);
  expect(await store.getSourceVersion('a')).toBeNull();
  fail = false; expect(await indexer.run()).toMatchObject({ added: 3, kept: 2, failed: 0 });
  expect(await store.getSourceDocuments('a')).toHaveLength(5);
});
test('a fatal error ends the run at once, a plain one only fails its source', async () => {
  const entries = [source('a'), source('b', 'Another descriptive paragraph.')];
  const plain = createIndexer({ store: createMemoryVectorStore(), embedder: { modelId: 'm', embedTexts: async () => { throw Error('bad text'); } }, sources: { list: async () => entries } });
  expect(await plain.run()).toMatchObject({ failed: 2, sources: 2 });
  const list = jest.fn(async () => entries.map((entry) => ({ ...entry, read: jest.fn(async () => entry) })));
  const stopped = createIndexer({ store: createMemoryVectorStore(), embedder: { modelId: 'm', embedTexts: async () => { throw Object.assign(Error('gone'), { fatal: true }); } }, sources: { list } });
  await expect(stopped.run()).rejects.toThrow('gone');
  expect(list).toHaveBeenCalledTimes(1);
  const wrongModel = createIndexer({ store: createMemoryVectorStore(), embedder: { modelId: 'm', embedTexts: async () => ({ modelId: 'other', vectors: [[1]] }) }, sources: { list: async () => entries } });
  await expect(wrongModel.run()).rejects.toThrow('EMBEDDING_UNAVAILABLE');
});
test('an unreadable source with a fingerprint is parked: its passages stay and it is not read again until it changes', async () => {
  const store = createMemoryVectorStore(); let fingerprint = 'v1'; let broken = false;
  const read = jest.fn(async () => { if (broken) throw Error('not a zip'); return { text: 'A descriptive paragraph with details.' }; });
  const indexer = createIndexer({ store, embedder: embedder(), sources: { list: async () => [{ id: 'a', fingerprint, read }] } });
  await indexer.run(); fingerprint = 'v2'; broken = true;
  expect(await indexer.run({ full: true })).toMatchObject({ failed: 1, parked: 1, removed: 0 });
  expect(await store.getSourceDocuments('a')).toHaveLength(1);
  expect(await indexer.run()).toMatchObject({ failed: 0, unchanged: 1 });
  expect(read).toHaveBeenCalledTimes(2);
  fingerprint = 'v3'; broken = false; expect(await indexer.run()).toMatchObject({ failed: 0, kept: 1 });
});
test('the run stops embedding at its bound, leaves the other sources and their passages alone, and says so', async () => {
  const entries = ['a', 'b', 'c', 'd'].map((id) => ({ id, fingerprint: id, text: `Descriptive paragraph of ${id}.` })); const store = createMemoryVectorStore();
  const indexer = createIndexer({ store, embedder: embedder(), sources: { list: async () => entries }, maxPassages: 2 });
  await indexer.run({ full: true }); await indexer.run({ full: true }); expect(await store.listSourceIds()).toEqual(['a', 'b', 'c', 'd']);
  const next = createIndexer({ store, embedder: embedder('m2'), sources: { list: async () => entries }, maxPassages: 2 });
  const first = await next.run({ full: true });
  expect(first).toMatchObject({ added: 2, sources: 2, remaining: true, removed: 0 });
  expect((await store.getSourceDocuments('c'))[0].modelId).toBe('m'); expect(await store.listSourceIds()).toHaveLength(4);
  const second = await next.run({ full: true });
  expect(second).toMatchObject({ added: 2, unchanged: 2, remaining: false });
  expect(await next.run({ full: true, maxPassages: 1 })).toMatchObject({ added: 0, unchanged: 4, remaining: false });
});
test('a bound never makes the sources left for later look gone', async () => {
  const entries = ['a', 'b', 'c'].map((id) => source(id, `Descriptive paragraph of ${id}.`)); const store = createMemoryVectorStore();
  const indexer = createIndexer({ store, embedder: embedder(), sources: { list: async () => entries }, maxPassages: 1 });
  const stats = await indexer.run({ full: true });
  expect(stats).toMatchObject({ added: 1, remaining: true, removed: 0 });
  expect((await store.listSourceIds()).length).toBe(1);
  entries.pop(); await indexer.run({ full: true }); await indexer.run({ full: true }); expect((await store.listSourceIds()).sort()).toEqual(['a', 'b']);
});
test('the passages to embed go shortest first, in batches of like length', async () => {
  const spy = jest.fn(); const text = ['A medium sized paragraph here.', 'Short one.', 'A very much longer paragraph than the others with many words in it.'].join('\n\n');
  const indexer = createIndexer({ store: createMemoryVectorStore(), embedder: embedder('m', spy), sources: { list: async () => [{ id: 'a', text, chunkOptions: { maxLength: 70 } }] } });
  await indexer.run();
  const lengths = spy.mock.calls.flatMap((call) => call[0].map((value) => value.length));
  expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
});
test('a store and an embedder can be given as functions, read again at every run', async () => {
  const stores = []; let model = 'm'; const spy = jest.fn();
  const indexer = createIndexer({ store: () => { const store = createMemoryVectorStore(); stores.push(store); return store; }, embedder: () => embedder(model, spy), sources: { list: async () => [source()] } });
  await indexer.run(); model = 'm2'; await indexer.run();
  expect(stores).toHaveLength(2); expect((await stores[1].getSourceDocuments('a'))[0].modelId).toBe('m2');
});
test('a watch reports every pass and its errors, does not mark a stopped full pass as done, and does not pause for a parked failure', async () => {
  let current = 0; const timers = []; const calls = []; const runs = []; const errors = []; let outcome = 'remaining';
  const indexer = createIndexer({ store: createMemoryVectorStore(), embedder: embedder(), maxPassages: 1, now: () => current, setTimer: (fn, ms) => { timers.push({ fn, ms }); return fn; }, clearTimer: jest.fn(),
    sources: { list: async ({ full }) => { calls.push(full); if (outcome === 'error') throw Error('list failed'); if (outcome === 'parked') return [{ id: 'p', fingerprint: 'f', read: async () => { throw Error('bad'); } }]; return [source('a'), source('b', 'Another descriptive paragraph.')]; } } });
  const tick = async (ms) => { current += ms; timers.shift().fn(); await new Promise((r) => setImmediate(r)); };
  const watcher = indexer.watch({ shortEveryMs: 10, fullEveryMs: 30, pauseAfterFailureMs: 500, onRun: (stats, info) => runs.push([stats.remaining, info.full]), onError: (error) => errors.push(error.message) });
  await new Promise((r) => setImmediate(r));
  expect(runs).toEqual([[true, true]]); await tick(10); expect(calls).toEqual([true, true]);
  outcome = 'parked'; await tick(10); await tick(10);
  expect(timers[0].ms).toBe(10);
  outcome = 'error'; await tick(10); expect(errors).toEqual(['list failed']); expect(timers[0].ms).toBe(500);
  await watcher.stop();
});
test('a store that cannot note a failure, or fails to, only leaves the source failed and retried', async () => {
  const entries = [{ id: 'a', fingerprint: 'v1', read: async () => { throw Error('bad'); } }];
  for (const noteSourceFailure of [async () => false, () => { throw Error('store down'); }, undefined]) {
    const store = Object.assign(createMemoryVectorStore(), { noteSourceFailure });
    const indexer = createIndexer({ store, embedder: embedder(), sources: { list: async () => entries } });
    expect(await indexer.run()).toMatchObject({ failed: 1, parked: 0 });
    expect(await indexer.run()).toMatchObject({ failed: 1, unchanged: 0 });
  }
});
