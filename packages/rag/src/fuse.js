function fuseByRank(lists, k = 60, weights = []) {
  if (!(k > 0) || !Array.isArray(lists)) throw new TypeError('INVALID_RRF');
  const entries = new Map();
  lists.forEach((list, listIndex) => {
    const weight = weights[listIndex] ?? 1;
    if (!(weight >= 0)) throw new TypeError('INVALID_RRF_WEIGHT');
    const seen = new Set();
    list.forEach((item, rank) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      const current = entries.get(item.id) || { item, score: 0, order: entries.size };
      current.score += weight / (k + rank + 1);
      entries.set(item.id, current);
    });
  });
  return [...entries.values()].sort((a, b) => b.score - a.score || a.order - b.order).map(({ item, score }) => ({ ...item, score }));
}
module.exports = { fuseByRank };
