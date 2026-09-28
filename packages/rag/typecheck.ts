import {
  assertVectorStoreContract, batches, chunkBlocks, chunkText, createEmbedder,
  createHybridSearch, createIndexer, createLocalEmbedder, createMemoryVectorStore,
  createRemoteEmbedder, createReranker, fuseByRank, normalizeDocument,
  runStoreContract, verifySources
} from './src';
import type { Block, Chunk, Document, Embedder, IndexStats, Reranker, VectorStore } from './src';
const store: VectorStore = createMemoryVectorStore();
const embedder: Embedder = createEmbedder({ modelId: 'example', embed: async (texts) => texts.map(() => [1, 0]) });
const local = createLocalEmbedder({ modelId: 'example', load: async () => async (texts) => texts.map(() => [1, 0]) });
const remote = createRemoteEmbedder({ url: 'https://example.invalid', modelId: 'example', fetch: async () => ({ ok: true, json: async () => ({ modelId: 'example', vectors: [[1, 0]] }) }), maskText: (text) => text });
const reranker: Reranker = createReranker({ score: async (_query, texts) => texts.map(() => 0.5) });
const search = createHybridSearch({ store, embedder, reranker });
const indexer = createIndexer({ store, embedder, sources: { list: async () => [{ id: 'a', text: 'Some text.' }] } });
const block: Block = { kind: 'paragraph', text: 'Some text.' };
const chunks: Chunk[] = chunkBlocks([block]);
const doc: Document = { id: 'a', sourceId: 'a', text: chunks[0]?.text || '', modelId: 'example', vector: [1, 0] };
const textChunks: string[] = chunkText('A.\n\nB.');
const ranked: Array<{ id: string; score: number }> = fuseByRank([[{ id: 'a' }]]);
const groups: string[][] = batches(['a'], 1, 10);
const normalized = normalizeDocument({ id: 'a', content: 'Some text.' });
async function exercise(): Promise<void> {
  await assertVectorStoreContract(createMemoryVectorStore);
  await store.replaceSource('a', 'v1', [doc]);
  await local.embed(['a'], { kind: 'query' });
  await remote.embed(['a'], { kind: 'query' });
  await search('a', { minSimilarity: 0.1, rerankBudgetMs: 10 });
  const stats: IndexStats = await indexer.run({ full: true });
  await verifySources('A claim.', ['A source.']);
  void [ranked, groups, normalized, textChunks, stats];
}
void exercise;
void runStoreContract;
