'use strict';

const MAX_CHARS = 4000;
const words = (text) => String(text).split(/\s+/).filter(Boolean);
const bounded = (list) => { const text = list.join(' '); return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text; };

/**
 * Difference between a proposed text and its final version, word by word:
 * the common start and end are dropped and the middle parts kept. Linear in
 * the length of the texts. Call it on MASKED texts only.
 */
function wordDelta(before, after) {
  const a = words(before); const b = words(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const removed = a.slice(start, endA); const added = b.slice(start, endB);
  return {
    removed: bounded(removed), added: bounded(added),
    removedWords: removed.length, addedWords: added.length,
    totalWordsBefore: a.length, totalWordsAfter: b.length,
    unchanged: removed.length === 0 && added.length === 0
  };
}

module.exports = { wordDelta };
