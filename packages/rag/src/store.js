function tokenize(text) { return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []; }
function cosine(a, b) {
  if (a.length !== b.length) return null;
  let dot = 0; let aa = 0; let bb = 0;
  for (let at = 0; at < a.length; at++) { dot += a[at] * b[at]; aa += a[at] ** 2; bb += b[at] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
const copy = (doc) => ({ ...doc, vector: [...doc.vector], ...(doc.metadata ? { metadata: { ...doc.metadata } } : {}) });
function createMemoryVectorStore({ titleWeight = 3, contextWeight = 0.5, k1 = 1.2, b = 0.75 } = {}) {
  const rows = new Map(); const versions = new Map();
  return {
    async replaceSource(sourceId, version, documents) {
      if (!sourceId || typeof version !== 'string' || !Array.isArray(documents)) throw new TypeError('INVALID_SOURCE');
      const ids = new Set();
      for (const doc of documents) {
        if (!doc.id || ids.has(doc.id) || doc.sourceId !== sourceId || !doc.modelId || typeof doc.text !== 'string' || !Array.isArray(doc.vector) || !doc.vector.length || doc.vector.some((n) => !Number.isFinite(n))) throw new TypeError('INVALID_DOCUMENT');
        ids.add(doc.id);
      }
      for (const doc of documents) if (rows.has(doc.id) && rows.get(doc.id).sourceId !== sourceId) throw new TypeError('DUPLICATE_DOCUMENT_ID');
      for (const [id, doc] of rows) if (doc.sourceId === sourceId) rows.delete(id);
      for (const doc of documents) rows.set(doc.id, copy(doc));
      versions.set(sourceId, version);
    },
    // Protocole incrémental (facultatif) : l'indexeur écrit tranche par tranche sans jamais recharger les vecteurs déjà stockés.
    async listSourceChunkIds(sourceId, modelId) { return [...rows.values()].filter((doc) => doc.sourceId === sourceId && doc.modelId === modelId).map((doc) => doc.id); },
    async putDocuments(sourceId, documents) {
      if (!sourceId || !Array.isArray(documents)) throw new TypeError('INVALID_SOURCE');
      const ids = new Set();
      for (const doc of documents) {
        if (!doc.id || ids.has(doc.id) || doc.sourceId !== sourceId || !doc.modelId || typeof doc.text !== 'string' || !Array.isArray(doc.vector) || !doc.vector.length || doc.vector.some((n) => !Number.isFinite(n))) throw new TypeError('INVALID_DOCUMENT');
        if (rows.has(doc.id) && rows.get(doc.id).sourceId !== sourceId) throw new TypeError('DUPLICATE_DOCUMENT_ID');
        ids.add(doc.id);
      }
      for (const doc of documents) rows.set(doc.id, copy(doc));
    },
    async commitSource(sourceId, version, keepIds) {
      if (!sourceId || typeof version !== 'string' || !Array.isArray(keepIds)) throw new TypeError('INVALID_SOURCE');
      const keep = new Set(keepIds); let removed = 0;
      for (const [id, doc] of rows) if (doc.sourceId === sourceId && !keep.has(id)) { rows.delete(id); removed++; }
      versions.set(sourceId, version);
      return { removed };
    },
    async noteSourceFailure(sourceId, version) { versions.set(sourceId, version); return true; },
    async getSourceVersion(sourceId) { return versions.get(sourceId) ?? null; },
    async listSourceIds() { return [...versions.keys()]; },
    async getSourceDocuments(sourceId) { return [...rows.values()].filter((doc) => doc.sourceId === sourceId).map(copy); },
    async removeSource(sourceId) { const count = [...rows.values()].filter((doc) => doc.sourceId === sourceId).length; versions.delete(sourceId); for (const [id, doc] of rows) if (doc.sourceId === sourceId) rows.delete(id); return count; },
    async searchKeyword(query, { limit = 40, filter } = {}) {
      const terms = [...new Set(tokenize(query))];
      if (!terms.length || limit <= 0) return [];
      const candidates = [...rows.values()].filter((doc) => !filter || filter(doc));
      if (!candidates.length) return [];
      const fields = candidates.map((doc) => {
        const title = tokenize(doc.title); const body = tokenize(doc.text); const context = tokenize(doc.context);
        return { doc, title, body, context, length: title.length + body.length + context.length };
      });
      const average = fields.reduce((total, row) => total + row.length, 0) / fields.length || 1;
      const frequency = new Map(terms.map((term) => [term, fields.filter((row) => row.title.includes(term) || row.body.includes(term) || row.context.includes(term)).length]));
      return fields.map((row) => {
        let keywordScore = 0;
        for (const term of terms) {
          const tf = row.title.filter((word) => word === term).length * titleWeight + row.body.filter((word) => word === term).length + row.context.filter((word) => word === term).length * contextWeight;
          if (!tf) continue;
          const idf = Math.log(1 + (fields.length - frequency.get(term) + 0.5) / (frequency.get(term) + 0.5));
          keywordScore += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * row.length / average));
        }
        return { ...copy(row.doc), keywordScore };
      }).filter((doc) => doc.keywordScore > 0).sort((a, b) => b.keywordScore - a.keywordScore || a.id.localeCompare(b.id)).slice(0, limit);
    },
    async searchVector(vector, modelId, { limit = 40, filter, minSimilarity = -1 } = {}) {
      if (!modelId || !Array.isArray(vector) || !vector.length || vector.some((n) => !Number.isFinite(n))) throw new TypeError('INVALID_VECTOR_QUERY');
      const candidates = [...rows.values()].filter((doc) => !filter || filter(doc));
      if (candidates.some((doc) => doc.modelId !== modelId || doc.vector.length !== vector.length)) return { code: 'EMBEDDING_SPACE_MISMATCH', results: [] };
      return { code: 'OK', results: candidates.map((doc) => ({ ...copy(doc), similarity: cosine(vector, doc.vector) })).filter((doc) => doc.similarity >= minSimilarity).sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, limit) };
    }
  };
}
async function assertVectorStoreContract(factory) {
  const store = await factory();
  const doc = { id: 'contract:a', sourceId: 'contract', text: 'alpha beta', vector: [1, 0], modelId: 'model-a' };
  await store.replaceSource('contract', 'v1', [doc]);
  if (await store.getSourceVersion('contract') !== 'v1') throw new Error('CONTRACT_VERSION');
  if (!(await store.listSourceIds()).includes('contract')) throw new Error('CONTRACT_SOURCES');
  if ((await store.getSourceDocuments('contract'))[0]?.id !== doc.id) throw new Error('CONTRACT_GET_DOCUMENTS');
  if ((await store.searchKeyword('alpha')).at(0)?.id !== doc.id) throw new Error('CONTRACT_KEYWORD');
  if ((await store.searchVector([1, 0], 'model-a')).results.at(0)?.id !== doc.id) throw new Error('CONTRACT_VECTOR');
  if ((await store.searchVector([1, 0], 'model-b')).code !== 'EMBEDDING_SPACE_MISMATCH') throw new Error('CONTRACT_SPACE');
  await store.replaceSource('contract', 'v2', []);
  if ((await store.searchKeyword('alpha')).length) throw new Error('CONTRACT_REPLACE');
  await store.removeSource('contract');
  if (await store.getSourceVersion('contract') !== null) throw new Error('CONTRACT_REMOVE');
}
module.exports = { createMemoryVectorStore, assertVectorStoreContract, tokenize, cosine };
