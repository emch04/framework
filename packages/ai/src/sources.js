/**
 * Sources: what was read, what the answer relies on, and whether the answer
 * contradicts them.
 *
 * Tools and search bring several passages; the model uses a few. Showing all
 * of them under the answer claims support it does not have. Three pieces:
 *
 *   createSourceLedger — collects sources as tools return them, and the text
 *     behind each one; a tool that returned SEVERAL sources does not tie its
 *     whole output to each of them;
 *   usedSources — keeps only the sources the answer relies on, told from the
 *     answer itself (its link, a reference both name, enough shared distinctive
 *     words). Nothing is ever added: a source is kept or left out;
 *   findContradiction — asks a local inference model whether a sentence of the
 *     answer contradicts the closest source. Only a clear contradiction counts;
 *     a doubt, a failure or a timeout says nothing.
 *
 * And rerankResults, for search results a local reranker orders better than
 * the engine that ranks for the whole web.
 */

const fold = (text) => String(text === null || text === undefined ? '' : text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function wordsOf(text, { minLength, common }) {
  return new Set(fold(text).split(/[^\p{L}\d]+/u).filter((word) => word.length >= minLength && !common.has(word)));
}

/**
 * @param {object} [options]
 * @param {Function} [options.keyOf] (source) => string. Default kind + JSON of ref, else url, else title.
 */
function createSourceLedger(options = {}) {
  const keyOf = options.keyOf || ((source) => (
    source.ref !== undefined ? `${source.kind || ''}:${JSON.stringify(source.ref)}` : `${source.kind || ''}:${source.url || source.title || ''}`
  ));
  const sources = new Map();
  const evidence = new Map();

  /** Record what a tool found, and — when it found exactly one source — what it gave. */
  function keep(found = [], data = null) {
    const list = Array.isArray(found) ? found.filter(Boolean) : [];
    const read = list.length === 1 && data !== null && data !== undefined
      ? (typeof data === 'string' ? data : JSON.stringify(data))
      : '';
    for (const source of list) {
      const key = keyOf(source);
      if (!sources.has(key)) sources.set(key, source);
      evidence.set(key, [evidence.get(key), source.title, source.excerpt, read].filter(Boolean).join('\n'));
    }
  }

  return {
    keep,
    sources: () => [...sources.values()],
    evidence: () => [...sources.keys()].map((key) => evidence.get(key) || ''),
    size: () => sources.size
  };
}

/**
 * @param {string} answer   the answer as the person reads it.
 * @param {object[]} sources what was read, in order.
 * @param {string[]} evidence the text behind each source.
 * @param {object} [options]
 * @param {Function} [options.references] (text) => places named in it. With
 *   `sameReference`, a source whose evidence names a place the answer names is kept.
 * @param {Function} [options.sameReference] (a, b) => boolean.
 * @param {Function} [options.ownReference] (source) => place | null — a source
 *   that IS a reference (a verse, an article number) is kept only when the
 *   answer names it.
 * @param {Iterable<string>} [options.commonWords] folded words never compared
 *   (the everyday words of your languages, and the names every answer says).
 * @param {number} [options.minWordLength] Default 5.
 * @param {number} [options.sharedMin] distinct shared words that tie a passage. Default 3.
 * @param {number} [options.shortEvidence] evidence with this many words or fewer needs only 2. Default 5.
 * @returns {object[]} the sources relied on, unchanged, in their order.
 */
function usedSources(answer, sources, evidence = [], options = {}) {
  const minLength = options.minWordLength || 5;
  const sharedMin = options.sharedMin || 3;
  const shortEvidence = options.shortEvidence || 5;
  const common = new Set([...(options.commonWords || [])].map(fold));
  const text = String(answer || '');
  const said = wordsOf(text, { minLength, common });
  const references = typeof options.references === 'function' ? options.references : null;
  const same = typeof options.sameReference === 'function' ? options.sameReference : null;
  const named = references ? references(text) || [] : [];

  return (Array.isArray(sources) ? sources : []).filter((source, index) => {
    if (typeof options.ownReference === 'function') {
      const own = options.ownReference(source);
      /* Without a way to read references, the source's own title named in
         the answer is the only honest test. */
      if (own) {
        if (!references || !same) return Boolean(source.title) && fold(text).includes(fold(source.title));
        return named.some((place) => same(place, own));
      }
    }
    if (source && source.url && text.includes(source.url)) return true;
    const behind = evidence[index] || '';
    if (references && same && named.length) {
      const inEvidence = references(behind) || [];
      if (inEvidence.some((place) => named.some((other) => same(place, other)))) return true;
    }
    const own = wordsOf(behind, { minLength, common });
    const shared = [...own].filter((word) => said.has(word)).length;
    const needed = own.size <= shortEvidence ? Math.min(2, own.size) : sharedMin;
    return own.size > 0 && shared >= needed;
  });
}

/* ───────────────────────── contradiction ───────────────────────── */

const cleanSentence = (sentence) => sentence
  .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
  .replace(/[*_`#]+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function factualSentences(answer, minWords) {
  return String(answer)
    .split(/(?<=[.!?…])\s+|\n+/)
    .map(cleanSentence)
    .filter((sentence) => !/[?¿]$/.test(sentence) && sentence.split(' ').length >= minWords);
}

/**
 * Does a sentence of the answer contradict the source closest to it?
 *
 * @param {string} answer
 * @param {Array<string|{content?: string, snippet?: string, url?: string, source?: string}>} sources
 * @param {object} options
 * @param {Function} options.compare async (pairs: {premise, hypothesis}[]) =>
 *   [{ entailment, neutral, contradiction }] | null — a local NLI model.
 * @param {number} [options.timeoutMs] give up after this. Default 1500: the
 *   answer is already on its way, it is not held for a check.
 * @returns {Promise<{contradicts: boolean, sentence: string|null, source: string|null} | null>}
 *   null when nothing could be checked — the caller then says nothing.
 */
async function findContradiction(answer, sources, options = {}) {
  const compare = options.compare;
  if (typeof compare !== 'function') throw new Error('findContradiction requires options.compare.');
  const none = { contradicts: false, sentence: null, source: null };
  if (typeof answer !== 'string' || !Array.isArray(sources)) return none;

  const minWords = options.minWords || 5;
  const sharedMin = options.sharedMin || 2;
  const maxPairs = options.maxPairs || 20;
  const contradictionMin = options.contradictionMin === undefined ? 0.8 : options.contradictionMin;
  const entailmentMax = options.entailmentMax === undefined ? 0.2 : options.entailmentMax;
  const common = new Set([...(options.commonWords || [])].map(fold));
  const words = (text) => new Set((fold(text).match(/[\p{L}\p{N}]+/gu) || []).filter((word) => (word.length >= 3 || /^\d+$/.test(word)) && !common.has(word)));

  const excerpts = sources.map((source) => {
    if (typeof source === 'string') return { text: source.trim(), name: source.trim() };
    const text = String((source && (source.content || source.snippet)) || '').trim();
    return { text, name: (source && (source.source || source.url)) || text };
  }).filter((excerpt) => excerpt.text).map((excerpt) => ({ ...excerpt, words: words(excerpt.text) }));
  const sentences = factualSentences(answer, minWords).map((text) => ({ text, words: words(text) }));

  const candidates = [];
  sentences.forEach((sentence, iSentence) => excerpts.forEach((excerpt, iExcerpt) => {
    let shared = 0;
    for (const word of sentence.words) if (excerpt.words.has(word)) shared += 1;
    if (shared >= sharedMin) candidates.push({ iSentence, iExcerpt, shared });
  }));
  if (!candidates.length) return none;

  const pairs = candidates.sort((a, b) => b.shared - a.shared).slice(0, maxPairs);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), options.timeoutMs || 1500); });
  let results;
  try {
    results = await Promise.race([
      Promise.resolve().then(() => compare(pairs.map((pair) => ({ premise: excerpts[pair.iExcerpt].text, hypothesis: sentences[pair.iSentence].text })))),
      timeout
    ]);
  } catch (_error) {
    results = null;
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(results) || results.length !== pairs.length) return null;

  /* Sorted by overlap: the first pair seen for a sentence is its closest source. */
  const seen = new Set();
  let worst = null;
  pairs.forEach((pair, index) => {
    if (seen.has(pair.iSentence)) return;
    seen.add(pair.iSentence);
    const verdict = results[index] || {};
    if (verdict.contradiction >= contradictionMin && verdict.entailment < entailmentMax && (!worst || verdict.contradiction > worst.score)) {
      worst = { score: verdict.contradiction, pair };
    }
  });
  if (!worst) return none;
  return { contradicts: true, sentence: sentences[worst.pair.iSentence].text, source: excerpts[worst.pair.iExcerpt].name };
}

/* ───────────────────────── rerank ───────────────────────── */

/**
 * Put the most relevant results first, and the sources in the same order.
 *
 * @param {string} query
 * @param {{ results: object[], sources?: object[] }} found
 * @param {object} options
 * @param {Function} options.score async (query, passages: string[]) => number[] | null.
 * @param {Function} [options.passageOf] (result) => string. Default title — content.
 * @param {Function} [options.sourceMatches] (source, result) => boolean. Default url === result.source || result.url.
 * @returns the same shape, reordered — or unchanged when the scorer has nothing to say.
 */
async function rerankResults(query, found, options = {}) {
  if (typeof options.score !== 'function') throw new Error('rerankResults requires options.score.');
  if (!found || !Array.isArray(found.results) || found.results.length < 2) return found;
  const passageOf = options.passageOf || ((result) => [result.title, result.content].filter(Boolean).join(' — '));
  let scores;
  try {
    scores = await options.score(query, found.results.map(passageOf));
  } catch (_error) {
    return found;
  }
  if (!Array.isArray(scores) || scores.length !== found.results.length || !scores.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return found;
  }
  const results = found.results
    .map((result, index) => ({ result, score: scores[index], index }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map(({ result }) => result);
  if (!Array.isArray(found.sources)) return { ...found, results };
  const matches = options.sourceMatches || ((source, result) => Boolean(source && result && source.url && (source.url === result.source || source.url === result.url)));
  const rank = (source) => {
    const index = results.findIndex((result) => matches(source, result));
    return index === -1 ? results.length : index;
  };
  const sources = found.sources
    .map((source, index) => ({ source, index, rank: rank(source) }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map(({ source }) => source);
  return { ...found, results, sources };
}

module.exports = { createSourceLedger, usedSources, findContradiction, rerankResults, factualSentences };
