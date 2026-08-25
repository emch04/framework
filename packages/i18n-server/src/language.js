/**
 * Which language the caller asked for.
 *
 * `Accept-Language` is what every browser and HTTP client already sends, so
 * reading it means clients need no change at all. A product that carries the
 * choice elsewhere — a user setting, a query parameter — passes its own
 * `read` function instead.
 */

/**
 * @param {object} options
 * @param {string[]} options.languages
 * @param {string} [options.defaultLanguage] defaults to the first entry.
 * @param {Function} [options.read] (req) => string|null|undefined, consulted
 *   BEFORE the header. A stored user preference should win over the browser's.
 */
function createLanguageResolver(options = {}) {
  const languages = options.languages || [];
  if (!languages.length) {
    throw new Error('createLanguageResolver requires options.languages.');
  }

  const defaultLanguage = options.defaultLanguage || languages[0];
  if (!languages.includes(defaultLanguage)) {
    throw new Error(`createLanguageResolver: defaultLanguage "${defaultLanguage}" is not in options.languages.`);
  }

  const supported = new Set(languages);
  const read = typeof options.read === 'function' ? options.read : null;

  /** Reduce "en-GB" to "en": we serve languages, not regional variants. */
  const base = (tag) => String(tag || '').trim().toLowerCase().split('-')[0];

  /**
   * @param {object} req anything with `headers`.
   * @returns {string} always one of `languages` — never null, never a tag we
   *   do not serve. A language we do not speak falls back to the default:
   *   a readable sentence in the wrong language beats a technical key.
   */
  function resolveLanguage(req) {
    if (read) {
      const preferred = base(read(req));
      if (supported.has(preferred)) return preferred;
    }

    const header = String(req?.headers?.['accept-language'] || '');
    if (!header) return defaultLanguage;

    /* The header is ordered by preference already — first match wins, even if
       an unsupported language is listed ahead of it. */
    for (const chunk of header.split(',')) {
      const tag = base(chunk.split(';')[0]);
      if (supported.has(tag)) return tag;
    }

    return defaultLanguage;
  }

  return { languages: [...languages], defaultLanguage, resolveLanguage };
}

module.exports = { createLanguageResolver };
