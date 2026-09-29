const { fuseByRank } = require('./fuse');
const { createReranker } = require('./rerank');
function createHybridSearch({ store, embedder, rerank, reranker, rrfK = 60, weights = [1, 1], ties = 'keyword', logger, setTimer, clearTimer } = {}) {
  if (!store || typeof store.searchKeyword !== 'function' || typeof store.searchVector !== 'function') throw new TypeError('INVALID_STORE');
  if (!['keyword', 'vector'].includes(ties)) throw new TypeError('INVALID_TIES');
  const rank = reranker || (rerank ? createReranker({ score: rerank, logger, setTimer, clearTimer }) : null);
  // `filter` n'est jamais appelé ici : il va tel quel au magasin, qui l'applique avant de rendre ses lignes (une fonction pour un magasin en mémoire, une description pour un magasin SQL).
  return async function search(query, { limit = 8, reach = 40, filter, alsoIn = [], rerankBudgetMs = 0, rerankMode = 'replace', minSimilarity = -1, perDocument = 2, perDocumentReranked, minRerankScore = -Infinity } = {}) {
    const text = String(query ?? '').trim();
    if (!text) return { code: 'OK', results: [], rerank: 'disabled' };
    if (!['replace', 'fuse'].includes(rerankMode)) throw new TypeError('INVALID_RERANK_MODE');
    const words = await store.searchKeyword(text, { limit: reach, filter });
    const wide = [];
    // Autres portées lues en plus, chacune comme une liste de la fusion (l'autre langue d'un corpus, un fonds voisin) : par le sens, et par les mots si `keyword`.
    for (const also of alsoIn) if (also.keyword) wide.push({ list: await store.searchKeyword(text, { limit: reach, filter: also.filter }), weight: also.weight ?? 1 });
    let semantic = []; let code = 'OK';
    if (embedder) {
      try {
        const embedded = await embedder.embedTexts([text], { kind: 'query' });
        if (embedded) {
          const result = await store.searchVector(embedded.vectors[0], embedded.modelId, { limit: reach, filter, minSimilarity });
          code = result.code;
          semantic = result.results.filter((item) => item.similarity === undefined || item.similarity >= minSimilarity);
          for (const also of alsoIn) {
            const more = await store.searchVector(embedded.vectors[0], embedded.modelId, { limit: reach, filter: also.filter, minSimilarity });
            wide.push({ list: more.results.filter((item) => item.similarity === undefined || item.similarity >= minSimilarity), weight: also.weight ?? 1 });
          }
        } else code = 'QUERY_MASK_REQUIRED';
      } catch (_error) { code = 'VECTOR_UNAVAILABLE'; logger?.warn?.({ code }); }
    }
    // À égalité de score, la première liste passe devant : `ties` choisit laquelle.
    const own = [{ list: words, weight: weights[0] ?? 1 }, { list: semantic, weight: weights[1] ?? 1 }];
    if (ties === 'vector') own.reverse();
    const lists = [...own, ...wide];
    const fuse = (more = []) => fuseByRank([...lists, ...more].map((item) => item.list), rrfK, [...lists, ...more].map((item) => item.weight));
    const fused = fuse();
    let ranked = fused;
    let rerankStatus = 'disabled';
    if (rank && rerankBudgetMs > 0 && fused.length) {
      const result = await rank(text, fused.slice(0, reach), rerankBudgetMs);
      rerankStatus = result.status;
      if (result.status === 'applied') {
        const scored = fused.slice(0, result.scores.length);
        const scoreOf = new Map(scored.map((item, index) => [item.id, result.scores[index]]));
        if (rerankMode === 'fuse') {
          // Le classement du reclasseur devient une liste de plus de la fusion ; seuls les candidats qu'il a lus restent, ceux sous le seuil s'en vont.
          const reread = [...scored].sort((a, b) => scoreOf.get(b.id) - scoreOf.get(a.id));
          ranked = fuse([{ list: reread, weight: 1 }]).filter((item) => scoreOf.get(item.id) >= minRerankScore).map((item) => ({ ...item, rerankScore: scoreOf.get(item.id) }));
        } else {
          ranked = fused.filter((item) => !scoreOf.has(item.id) || scoreOf.get(item.id) >= minRerankScore)
            .map((item) => ({ ...item, rerankScore: scoreOf.get(item.id) }))
            .sort((a, b) => (b.rerankScore ?? -Infinity) - (a.rerankScore ?? -Infinity) || b.score - a.score);
        }
      }
    }
    // Le plafond par document peut ne valoir qu'après reclassement : sans lui, la liste fusionnée est rendue telle quelle.
    const cap = rerankStatus === 'applied' ? perDocumentReranked ?? perDocument : perDocument;
    const counts = new Map(); const results = [];
    for (const item of ranked) {
      const key = item.documentId ?? item.sourceId ?? item.id;
      if ((counts.get(key) || 0) >= cap) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      results.push(item);
      if (results.length >= limit) break;
    }
    return { code, results, rerank: rerankStatus };
  };
}
module.exports = { createHybridSearch };
