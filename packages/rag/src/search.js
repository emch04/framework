const { fuseByRank } = require('./fuse');
const { createReranker } = require('./rerank');
function createHybridSearch({ store, embedder, rerank, reranker, rrfK = 60, weights = [1, 1], logger, setTimer, clearTimer } = {}) {
  if (!store || typeof store.searchKeyword !== 'function' || typeof store.searchVector !== 'function') throw new TypeError('INVALID_STORE');
  const rank = reranker || (rerank ? createReranker({ score: rerank, logger, setTimer, clearTimer }) : null);
  return async function search(query, { limit = 8, reach = 40, filter, rerankBudgetMs = 0, minSimilarity = -1, perDocument = 2, minRerankScore = -Infinity } = {}) {
    const text = String(query ?? '').trim();
    if (!text) return { code: 'OK', results: [], rerank: 'disabled' };
    const words = await store.searchKeyword(text, { limit: reach, filter });
    let semantic = []; let code = 'OK';
    if (embedder) {
      try {
        const embedded = await embedder.embedTexts([text], { kind: 'query' });
        if (embedded) {
          const result = await store.searchVector(embedded.vectors[0], embedded.modelId, { limit: reach, filter, minSimilarity });
          code = result.code;
          semantic = result.results.filter((item) => item.similarity === undefined || item.similarity >= minSimilarity);
        } else code = 'QUERY_MASK_REQUIRED';
      } catch (_error) { code = 'VECTOR_UNAVAILABLE'; logger?.warn?.({ code }); }
    }
    const fused = fuseByRank([words, semantic], rrfK, weights);
    let ranked = fused;
    let rerankStatus = 'disabled';
    if (rank && rerankBudgetMs > 0 && fused.length) {
      const result = await rank(text, fused.slice(0, reach), rerankBudgetMs);
      rerankStatus = result.status;
      if (result.status === 'applied') {
        const scoreOf = new Map(fused.slice(0, result.scores.length).map((item, index) => [item.id, result.scores[index]]));
        ranked = fused.filter((item) => !scoreOf.has(item.id) || scoreOf.get(item.id) >= minRerankScore)
          .map((item) => ({ ...item, rerankScore: scoreOf.get(item.id) }))
          .sort((a, b) => (b.rerankScore ?? -Infinity) - (a.rerankScore ?? -Infinity) || b.score - a.score);
      }
    }
    const counts = new Map(); const results = [];
    for (const item of ranked) {
      const key = item.documentId ?? item.sourceId ?? item.id;
      if ((counts.get(key) || 0) >= perDocument) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      results.push(item);
      if (results.length >= limit) break;
    }
    return { code, results, rerank: rerankStatus };
  };
}
module.exports = { createHybridSearch };
