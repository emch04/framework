/**
 * Handing the model passages that may not be in the reader's language.
 *
 * A question in English may be best answered from a text that exists only in
 * French. Dropping it loses the answer; slipping it in unmarked gets it quoted
 * in French, or "translated" with a reference the reader cannot find. So each
 * passage says its language, in a tag the model cannot miss — `[fr]` — and one
 * instruction says what to do with a tagged passage: translate what you use,
 * keep the ORIGINAL reference, so the reader can go and check it.
 *
 * Language tags are compared on their primary subtag: `fr-FR` and `fr` are
 * the same language, and marking one as foreign to the other would have the
 * model "translate" French into French.
 *
 * No wording lives here: the header, footer, instruction and "nothing found"
 * lines are the caller's, per language. `{languages}` in the instruction is
 * replaced by the tags found.
 */

/** 'fr-FR', 'FR', ' fr_ca ' -> 'fr'. Null for nothing usable. */
function primaryLanguage(tag) {
  if (typeof tag !== 'string') return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

function isForeign(passageLanguage, readerLanguage) {
  const passage = primaryLanguage(passageLanguage);
  const reader = primaryLanguage(readerLanguage);
  return Boolean(passage && reader && passage !== reader);
}

const defaultTag = (language) => `[${language}]`;

/**
 * @param {Array<{title?: string, text: string, lang?: string}>} passages
 * @param {object} options
 * @param {string} options.lang   the reader's language.
 * @param {Function} [options.tag] (primaryLanguage) => string. Default "[fr]".
 * @returns {{ blocks: string[], languages: string[] }} one block per passage;
 *   `languages` lists the foreign tags present, in order of appearance.
 */
function markForeignPassages(passages, { lang, tag = defaultTag } = {}) {
  const languages = [];
  const blocks = (Array.isArray(passages) ? passages : []).filter((passage) => passage && passage.text).map((passage) => {
    const foreign = isForeign(passage.lang, lang);
    const primary = foreign ? primaryLanguage(passage.lang) : null;
    if (primary && !languages.includes(primary)) languages.push(primary);
    const title = [passage.title, primary ? tag(primary) : null].filter(Boolean).join(' ');
    return title ? `${title}\n${passage.text}` : String(passage.text);
  });
  return { blocks, languages };
}

/**
 * The passages block of a system prompt.
 *
 * @param {object} options
 * @param {Array|null} options.passages  null when the SEARCH failed — then
 *   nothing is said about the library, rather than "nothing found", which
 *   would be a lie; [] when it found nothing.
 * @param {string} options.lang
 * @param {object} options.texts  { header?, footer?, foreign (required when a
 *   passage can be foreign), empty? } — the caller's words.
 * @param {Function} [options.tag]
 * @returns {string[]} lines to join into the system prompt.
 */
function buildPassagesContext({ passages, lang, texts = {}, tag } = {}) {
  if (passages === null || passages === undefined) return [];
  const { blocks, languages } = markForeignPassages(passages, { lang, tag });
  if (!blocks.length) return texts.empty ? [texts.empty] : [];
  if (languages.length && !(typeof texts.foreign === 'string' && texts.foreign.trim())) {
    /* A tagged passage without the instruction is worse than no tag: the
       model sees "[fr]" and guesses what it means. */
    throw new Error('buildPassagesContext: a passage is in another language but texts.foreign is missing.');
  }
  return [
    ...(texts.header ? [texts.header] : []),
    ...blocks,
    ...(texts.footer ? [texts.footer] : []),
    ...(languages.length ? [texts.foreign.replace(/\{languages\}/g, () => languages.map((language) => (tag || defaultTag)(language)).join(', '))] : [])
  ];
}

/**
 * The source card of a passage: its reference untouched — the original, even
 * when the answer is a translation — and a short excerpt.
 */
function passageSource(passage, { excerptMax = 300 } = {}) {
  const text = String((passage && passage.text) || '');
  return {
    ...(passage.kind ? { kind: passage.kind } : {}),
    ...(passage.title ? { title: passage.title } : {}),
    ...(passage.ref !== undefined ? { ref: passage.ref } : {}),
    ...(passage.url ? { url: passage.url } : {}),
    ...(passage.lang ? { lang: passage.lang } : {}),
    excerpt: text.length > excerptMax ? text.slice(0, excerptMax) : text
  };
}

module.exports = { primaryLanguage, isForeignLanguage: isForeign, markForeignPassages, buildPassagesContext, passageSource };
