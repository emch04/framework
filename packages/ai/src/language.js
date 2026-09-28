/**
 * The language to answer in.
 *
 * The language set in the app stays the rule; a message CLEARLY written in
 * another supported language is answered in that one. Two readers:
 *
 *   1. the small words — articles, pronouns, the few verbs of every sentence
 *      — which decide a short message ("merci", "ok") that no statistical
 *      identifier can;
 *   2. an identifier (fastText's lid.176 or anything alike), injected, trusted
 *      only above a confidence — a far higher one for a message of two words.
 *
 * Anything else — an unsupported language, a message too short to tell, the
 * identifier out of reach — keeps the app's language. Guessing wrong switches
 * the whole answer, the voice and the sources into a language the person did
 * not ask for.
 */

/**
 * @param {object} options
 * @param {Record<string, string[]>} options.words  language -> its small words (lower case).
 * @param {Function} [options.identify] async (text) => { language, confidence }.
 * @param {string} [options.fallback]   when the app language is not supported. Default: the first language.
 * @param {number} [options.confidenceMin]      Default 0.5.
 * @param {number} [options.shortConfidenceMin] for fewer than `shortWords` words. Default 0.9.
 * @param {number} [options.shortWords]  Default 3.
 * @param {number} [options.lead]        how far the small words must lean to decide alone. Default 2.
 * @param {number} [options.maxChars]    text handed to the identifier. Default 2000.
 */
function createLanguageDetector(options = {}) {
  const entries = Object.entries(options.words || {});
  if (entries.length < 2) throw new Error('createLanguageDetector requires small words for at least two languages.');
  const sets = new Map(entries.map(([language, list]) => [language, new Set(list.map((word) => String(word).toLowerCase().replace(/’/g, "'")))]));
  const languages = [...sets.keys()];
  const identify = typeof options.identify === 'function' ? options.identify : null;
  const fallbackLanguage = languages.includes(options.fallback) ? options.fallback : languages[0];
  const confidenceMin = options.confidenceMin === undefined ? 0.5 : options.confidenceMin;
  const shortConfidenceMin = options.shortConfidenceMin === undefined ? 0.9 : options.shortConfidenceMin;
  const shortWords = options.shortWords || 3;
  const lead = options.lead || 2;
  const maxChars = options.maxChars || 2000;

  /** The small words' vote: a language, or null when they do not lean clearly. */
  function byWords(text) {
    const words = (String(text === null || text === undefined ? '' : text).toLowerCase().match(/[\p{L}'’-]+/gu) || [])
      .map((word) => word.replace(/’/g, "'"));
    const counts = languages.map((language) => ({ language, count: words.filter((word) => sets.get(language).has(word)).length }))
      .sort((a, b) => b.count - a.count);
    const [first, second] = counts;
    if (!first.count) return null;
    if (first.count >= second.count + lead) return first.language;
    /* One or two words, all from one language: "merci", "thank you". */
    if (words.length <= 2 && second.count === 0) return first.language;
    return null;
  }

  /**
   * @param {string} text what the person wrote.
   * @param {string} appLanguage the language set in the app.
   */
  async function reply(text, appLanguage) {
    const fallback = languages.includes(appLanguage) ? appLanguage : fallbackLanguage;
    const written = String(text === null || text === undefined ? '' : text).trim();
    if (!written) return fallback;
    const words = byWords(written);
    if (identify) {
      try {
        const found = await identify(written.slice(0, maxChars));
        const language = found && typeof found.language === 'string' ? found.language.toLowerCase() : null;
        const confidence = Number(found && found.confidence) || 0;
        const short = (written.match(/\p{L}+/gu) || []).length < shortWords;
        if (confidence >= (short ? shortConfidenceMin : confidenceMin)) {
          return languages.includes(language) ? language : (words || fallback);
        }
      } catch (_error) {
        /* The identifier out of reach: the small words alone. */
      }
    }
    return words || fallback;
  }

  return { byWords, reply, languages };
}

module.exports = { createLanguageDetector };
