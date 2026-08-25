/**
 * Translating what the SERVER says.
 *
 * Interface text is translated on the client; error messages are not. They come
 * back from the API and get shown as-is, so an app running in English still
 * answers "Cet élève est introuvable." to an English-speaking parent. It is the
 * kind of gap nobody notices until someone who cannot read the default language
 * hits an error.
 *
 * The trick that makes this cheap to adopt: **the key is the source sentence
 * itself**. No identifiers to invent, no call sites to touch, and a sentence
 * missing from the catalogue simply comes back in the source language — which
 * is exactly what happens today. You can therefore add this to a running
 * product and fill the catalogue afterwards, with no regression in between.
 */

/**
 * @param {object} options
 * @param {string[]} options.languages       every language served, e.g. ['fr','en','es'].
 * @param {string} [options.defaultLanguage] the language the source sentences
 *   are written in. Defaults to the first entry.
 * @param {Record<string, Record<string, string>>} [options.messages]
 *   source sentence -> { language: translation }.
 */
function createMessageCatalog(options = {}) {
  const languages = options.languages || [];
  if (!languages.length) {
    throw new Error('createMessageCatalog requires options.languages.');
  }

  const defaultLanguage = options.defaultLanguage || languages[0];
  if (!languages.includes(defaultLanguage)) {
    throw new Error(`createMessageCatalog: defaultLanguage "${defaultLanguage}" is not in options.languages.`);
  }

  const supported = new Set(languages);
  const messages = new Map();

  for (const [source, translations] of Object.entries(options.messages || {})) {
    if (!translations || typeof translations !== 'object') {
      throw new Error(`createMessageCatalog: translations for "${source}" must be an object keyed by language.`);
    }
    for (const language of Object.keys(translations)) {
      if (!supported.has(language)) {
        throw new Error(`createMessageCatalog: "${source}" declares unknown language "${language}".`);
      }
    }
    messages.set(source, { ...translations });
  }

  /**
   * Translate if we can, return the source sentence if we cannot.
   *
   * Never returns empty, never returns a key. A half-filled catalogue degrades
   * to readable text rather than to something technical.
   */
  function translate(message, language) {
    if (!message || typeof message !== 'string') return message;
    if (language === defaultLanguage || !supported.has(language)) return message;
    const entry = messages.get(message);
    if (!entry) return message;
    return entry[language] || message;
  }

  /**
   * How full is the catalogue, per language?
   *
   * The number that tells you whether this is finished. A catalogue nobody
   * measures is a catalogue that stops being filled.
   */
  function coverage() {
    const total = messages.size;
    const report = {};
    for (const language of languages) {
      if (language === defaultLanguage) {
        report[language] = { translated: total, total, missing: [] };
        continue;
      }
      const missing = [];
      for (const [source, entry] of messages) {
        if (!entry[language]) missing.push(source);
      }
      report[language] = { translated: total - missing.length, total, missing };
    }
    return report;
  }

  return {
    languages: [...languages],
    defaultLanguage,
    supports: (language) => supported.has(language),
    has: (message) => messages.has(message),
    translate,
    coverage,
    size: () => messages.size
  };
}

module.exports = { createMessageCatalog };
