const { tokenize } = require('./store');
function factualClaims(answer) {
  return String(answer ?? '').split(/(?<=[.!?…])\s+|\n+/).map((claim) => claim.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/[*_`#]+/g, '').trim()).filter((claim) => claim && !/[?¿]$/.test(claim));
}
async function verifySources(answer, sources, { nli, maxPairs = 20, minOverlap = 2, contradictionThreshold = 0.8, supportThreshold = 0.5 } = {}) {
  if (typeof nli !== 'function') return { code: 'NLI_UNAVAILABLE', claims: [], flags: [] };
  const excerpts = (sources || []).map((source) => typeof source === 'string' ? { text: source, source: null } : { text: source.text || source.content || '', source: source.source || source.url || null }).filter((source) => source.text);
  const claims = factualClaims(answer);
  const selected = claims.map((claim) => {
    const terms = new Set(tokenize(claim));
    const closest = excerpts.map((source) => ({ source, overlap: [...terms].filter((word) => tokenize(source.text).includes(word)).length })).sort((a, b) => b.overlap - a.overlap)[0];
    return { claim, source: closest?.overlap >= minOverlap ? closest.source : null };
  });
  const comparable = selected.filter((item) => item.source).slice(0, maxPairs);
  let scores;
  try { scores = comparable.length ? await nli(comparable.map(({ claim, source }) => ({ premise: source.text, hypothesis: claim }))) : []; }
  catch (_error) { return { code: 'NLI_UNAVAILABLE', claims: [], flags: [] }; }
  if (!Array.isArray(scores) || scores.length !== comparable.length || scores.some((score) => !Number.isFinite(score?.entailment) || !Number.isFinite(score?.contradiction))) return { code: 'NLI_UNAVAILABLE', claims: [], flags: [] };
  const scoreMap = new Map(comparable.map((pair, index) => [pair, scores[index]]));
  const assessed = selected.map((pair) => {
    const score = scoreMap.get(pair);
    let category = 'UNSUPPORTED';
    if (score?.contradiction >= contradictionThreshold && score.entailment < supportThreshold) category = 'CONTRADICTED';
    else if (score?.entailment >= supportThreshold) category = 'SUPPORTED';
    return { category, claim: pair.claim, source: pair.source?.source ?? null };
  });
  const flags = assessed.filter((item) => item.category !== 'SUPPORTED').map((item) => ({ code: item.category === 'CONTRADICTED' ? 'CONTRADICTION' : 'UNSUPPORTED_CLAIM', claim: item.claim, source: item.source }));
  return { code: 'OK', claims: assessed, flags };
}
module.exports = { verifySources, factualClaims };
