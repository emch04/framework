'use strict';

function createSpeechChunker({ maxLength = 160, abbreviations = [] } = {}) {
  const shortForms = new Set(abbreviations.map((word) => String(word).toLocaleLowerCase()));
  let buffer = '';
  function nextEnd() {
    const sentence = /[.!?…]+["»”)]?(?=\s)/gu;
    for (const found of buffer.matchAll(sentence)) {
      const previous = buffer.slice(0, found.index).match(/([\p{L}]+)$/u)?.[1]?.toLocaleLowerCase();
      if (found[0] === '.' && previous && shortForms.has(previous)) continue;
      return found.index + found[0].length;
    }
    if (buffer.length <= maxLength) return -1;
    let boundary = -1;
    for (const found of buffer.matchAll(/[,;:](?=\s)/gu)) boundary = found.index + 1;
    return boundary;
  }
  return {
    push(chunk) {
      buffer += String(chunk ?? '');
      const out = [];
      for (let end = nextEnd(); end > 0; end = nextEnd()) {
        const piece = buffer.slice(0, end).trim();
        buffer = buffer.slice(end);
        if (piece) out.push(piece);
      }
      return out;
    },
    flush() { const remaining = buffer.trim(); buffer = ''; return remaining ? [remaining] : []; }
  };
}

function words(text, ignoredWords = []) {
  const ignored = new Set(ignoredWords.map((word) => String(word).toLocaleLowerCase()));
  return (String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((word) => !ignored.has(word) && !/^\d+$/u.test(word));
}

function compareSpokenText(expected, spoken, { ignoredWords = [] } = {}) {
  const a = words(expected, ignoredWords);
  const b = words(spoken, ignoredWords);
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const prior = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = prior;
    }
  }
  const common = row[b.length];
  return { precision: b.length ? common / b.length : 1, coverage: a.length ? common / a.length : 1 };
}

function hasSpeechDrift(expected, spoken, options = {}) {
  const { precision, coverage } = compareSpokenText(expected, spoken, options);
  if (options.final) return precision < (options.minPrecision ?? 0.75) || coverage < (options.minCoverage ?? 0.8);
  return words(spoken, options.ignoredWords || []).length >= (options.minWords ?? 4) && precision < (options.minPrecision ?? 0.75);
}

function buildExpectedVocabulary(groups = [], { maxChars = 600 } = {}) {
  const seen = new Set();
  const result = [];
  let length = 0;
  for (const group of groups) {
    for (const raw of group) {
      const word = String(raw ?? '').trim();
      const key = word.toLocaleLowerCase();
      if (!word || seen.has(key)) continue;
      seen.add(key);
      const next = length + word.length + (result.length ? 1 : 0);
      if (next > maxChars) continue;
      result.push(word);
      length = next;
    }
  }
  return result.join(' ');
}

module.exports = { createSpeechChunker, compareSpokenText, hasSpeechDrift, buildExpectedVocabulary };
