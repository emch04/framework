function batches(texts, maxTexts, maxCharacters) {
  const batches = []; let current = []; let chars = 0;
  for (const text of texts) {
    if (text.length > maxCharacters) throw new TypeError('TEXT_TOO_LONG');
    if (current.length && (current.length >= maxTexts || chars + text.length > maxCharacters)) { batches.push(current); current = []; chars = 0; }
    current.push(text); chars += text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}
function createEmbedder({ modelId, embed, batchSize = 32, maxBatchCharacters = 16_000, maxTextLength = 8_000, prefixes = { query: '', passage: '' }, external = false, maskText, maskQuery } = {}) {
  if (!modelId || typeof embed !== 'function' || !Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(maxBatchCharacters) || maxBatchCharacters < 1 || !Number.isInteger(maxTextLength) || maxTextLength < 1) throw new TypeError('INVALID_EMBEDDER');
  async function embedTexts(texts, { kind = 'passage' } = {}) {
    if (!Array.isArray(texts) || !['query', 'passage'].includes(kind) || texts.some((text) => typeof text !== 'string')) throw new TypeError('INVALID_TEXTS');
    if (external && typeof maskText !== 'function' && !(kind === 'query' && typeof maskQuery === 'function')) return null;
    const masker = external ? (maskText || maskQuery) : null;
    const safe = masker ? await Promise.all(texts.map((text) => masker(text, { kind, modelId }))) : texts;
    if (safe.some((text) => typeof text !== 'string')) throw new TypeError('INVALID_MASKED_TEXT');
    const prepared = safe.map((text) => `${prefixes[kind] ?? ''}${text}`);
    if (prepared.some((text) => text.length > maxTextLength)) throw new TypeError('TEXT_TOO_LONG');
    const vectors = [];
    for (const batch of batches(prepared, batchSize, maxBatchCharacters)) {
      const result = await embed(batch, { kind, modelId });
      if (!Array.isArray(result) || result.length !== batch.length || result.some((vector) => !Array.isArray(vector) || !vector.length || vector.some((n) => !Number.isFinite(n)))) throw new TypeError('INVALID_VECTORS');
      vectors.push(...result);
    }
    const dimensions = vectors[0]?.length;
    if (vectors.some((vector) => vector.length !== dimensions)) throw new TypeError('MIXED_VECTOR_DIMENSIONS');
    return { modelId, vectors };
  }
  return { modelId, embedTexts, limits: { batchSize, maxBatchCharacters } };
}
module.exports = { createEmbedder, batches };
