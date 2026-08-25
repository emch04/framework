/**
 * Translation at the response boundary, so no call site changes.
 *
 * This is the point of the whole package. Controllers keep writing sentences in
 * the source language exactly as they do now; the translation happens once, on
 * the way out, by wrapping `res.json`. Hundreds of existing calls keep working
 * and start being translated on the same day.
 *
 * Only the fields you name are touched — a message meant for a human. Never the
 * data payload: translating a value would corrupt it.
 */

/**
 * @param {object} options
 * @param {object} options.catalog   from createMessageCatalog().
 * @param {object} options.resolver  from createLanguageResolver().
 * @param {string[]} [options.fields] response fields to translate. Default ['message'].
 * @param {string} [options.attach]  request property to hold the resolved
 *   language, so controllers can read it. Default 'language'.
 */
function createTranslationMiddleware(options = {}) {
  const catalog = options.catalog;
  if (!catalog || typeof catalog.translate !== 'function') {
    throw new Error('createTranslationMiddleware requires options.catalog from createMessageCatalog().');
  }

  const resolver = options.resolver;
  if (!resolver || typeof resolver.resolveLanguage !== 'function') {
    throw new Error('createTranslationMiddleware requires options.resolver from createLanguageResolver().');
  }

  const fields = options.fields || ['message'];
  const attach = options.attach || 'language';

  return function translationMiddleware(req, res, next) {
    const language = resolver.resolveLanguage(req);
    req[attach] = language;

    /* Nothing to do when the caller reads the source language — and skipping
       the wrapper entirely keeps the common case free. */
    if (language === catalog.defaultLanguage) return next();

    const original = res.json.bind(res);
    res.json = (payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return original(payload);

      let touched = null;
      for (const field of fields) {
        const value = payload[field];
        if (typeof value !== 'string') continue;
        const translated = catalog.translate(value, language);
        if (translated === value) continue;
        touched = touched || { ...payload };
        touched[field] = translated;
      }

      return original(touched || payload);
    };

    return next();
  };
}

module.exports = { createTranslationMiddleware };
