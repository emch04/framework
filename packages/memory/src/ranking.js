/**
 * Pure ranking helpers: no store, no clock, no network.
 */
const { wordsOf } = require('./rules');

/* Vectors of different lengths are compared on their common part; a zero vector scores 0. */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  const size = Math.min(a.length, b.length);
  for (let i = 0; i < size; i += 1) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

/* Share of the query's words (3 letters or more, accents folded) found in the text. */
function keywordScore(query, text) {
  const extract = (value) => new Set(wordsOf(value).split(' ').filter((word) => word.length >= 3));
  const asked = extract(query);
  if (!asked.size) return 0;
  const found = extract(text);
  let shared = 0;
  asked.forEach((word) => { if (found.has(word)) shared += 1; });
  return shared / asked.size;
}

/**
 * Reciprocal rank fusion: each list votes 1 / (k + rank). An id near the top
 * of both lists beats one at the top of a single list.
 *
 * @param {string[][]} lists ranked ids, best first.
 * @param {number} [k=60]
 * @returns {string[]}
 */
function fuseByRank(lists, k = 60) {
  const scores = new Map();
  for (const list of Array.isArray(lists) ? lists : []) {
    (list || []).forEach((id, index) => scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1)));
  }
  return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const time = (value) => (value ? new Date(value).getTime() : 0);

/**
 * The short text always handed to the model: important memories first by the
 * most recently useful, cut on a whole memory, never mid-sentence. By default
 * the portrait stops at the first memory that no longer fits; with `fill`, that
 * one is left out and the shorter ones after it still get their place.
 */
function buildPortrait(memories, { maxLength = 1200, minImportance = 4, format = (memory) => `- ${memory.text}`, fill = false } = {}) {
  const rows = (memories || [])
    .filter((memory) => Number(memory.importance) >= minImportance)
    .sort((a, b) => time(b.lastUsedAt) - time(a.lastUsedAt)
      || b.importance - a.importance
      || time(b.createdAt) - time(a.createdAt));
  let out = '';
  for (const memory of rows) {
    const line = format(memory);
    if (out.length + (out ? 1 : 0) + line.length > maxLength) {
      if (fill) continue;
      break;
    }
    out += (out ? '\n' : '') + line;
  }
  return out;
}

module.exports = {
  cosine,
  keywordScore,
  fuseByRank,
  buildPortrait
};
