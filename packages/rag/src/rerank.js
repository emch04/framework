function createReranker({ score, maxCandidates = 40, maxTextLength = 2_000, setTimer = setTimeout, clearTimer = clearTimeout, logger, external = false, maskText } = {}) {
  if (typeof score !== 'function') throw new TypeError('INVALID_RERANKER');
  return async function rerank(query, candidates, budgetMs) {
    if (!(budgetMs > 0) || !candidates.length) return { status: 'disabled', scores: null };
    if (external && typeof maskText !== 'function') return { status: 'mask_required', scores: null };
    let timer;
    try {
      const work = async () => {
        const selected = candidates.slice(0, maxCandidates);
        const safeQuery = external ? await maskText(query, { kind: 'query' }) : query;
        const texts = await Promise.all(selected.map((candidate) => {
          const text = [candidate.title, candidate.text].filter(Boolean).join('\n').slice(0, maxTextLength);
          return external ? maskText(text, { kind: 'passage' }) : text;
        }));
        if (typeof safeQuery !== 'string' || texts.some((text) => typeof text !== 'string')) throw new TypeError('INVALID_MASKED_TEXT');
        return score(safeQuery.slice(0, maxTextLength), texts);
      };
      const result = await Promise.race([
        Promise.resolve().then(work),
        new Promise((resolve) => { timer = setTimer(() => resolve({ timeout: true }), budgetMs); })
      ]);
      if (result?.timeout) return { status: 'timeout', scores: null };
      if (!Array.isArray(result) || result.length !== Math.min(candidates.length, maxCandidates) || result.some((value) => !Number.isFinite(value))) return { status: 'invalid', scores: null };
      return { status: 'applied', scores: result };
    } catch (_error) { logger?.warn?.({ code: 'RERANK_FAILED' }); return { status: 'failed', scores: null }; }
    finally { if (timer !== undefined) clearTimer(timer); }
  };
}
module.exports = { createReranker };
