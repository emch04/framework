/**
 * The language of a RECIPIENT, which is not the language of a request.
 *
 * `createLanguageResolver` answers "which language did the caller ask for?".
 * Mail asks a different question: "which language does the person we are
 * writing to read?". Most mail leaves from a scheduled job, a queue, or an
 * action taken by SOMEONE ELSE — an administrator resetting a password, a
 * teacher messaging a family. There is no request from the recipient at all,
 * and the header of the request that does exist belongs to the sender.
 *
 * Two lessons shaped this module, both paid for in production:
 *
 *   1. The mail language is its own setting. People work in one language and
 *      want their mail in another — an app used in English by someone whose
 *      inbox, family and paperwork are in French. So a dedicated field
 *      (`emailLang` by default) is read FIRST, with an "auto" value that
 *      means "follow the interface".
 *
 *   2. The recipient must be RE-READ with those fields. The session token
 *      carries an id and a role, never the language; an account read with a
 *      projection written for something else (`email fullName`) has lost them
 *      too. Either way the resolver sees nothing, falls back to the default,
 *      and the mail goes out in the wrong language — silently, because a
 *      mail in the wrong language still "works". The founder of the product
 *      this came from had set his mail to English and kept receiving
 *      French. `createRecipientReloader` exists for that.
 */
const { createLanguageResolver } = require('./language');

/** "en-GB" -> "en". Same reduction as the request resolver. */
const base = (tag) => String(tag || '').trim().toLowerCase().split('-')[0];

/** Read "a.b.c" on an object without throwing on a missing step. */
const pick = (object, path) => path.split('.').reduce((value, step) => (value == null ? undefined : value[step]), object);

/**
 * @param {object} options
 * @param {string[]} options.languages
 * @param {string} [options.defaultLanguage] defaults to the first entry.
 * @param {string} [options.mailField] the mail-specific choice. Default 'emailLang'.
 * @param {string[]} [options.interfaceFields] the interface language, tried in
 *   order when the mail choice is absent or "auto". Dotted paths allowed.
 *   Default ['lang'].
 * @param {string} [options.followValue] the mail choice meaning "follow the
 *   interface". Default 'auto'.
 */
function createRecipientLanguage(options = {}) {
  if (!options.languages || !options.languages.length) {
    throw new Error('createRecipientLanguage requires options.languages.');
  }
  const resolver = createLanguageResolver({
    languages: options.languages,
    defaultLanguage: options.defaultLanguage
  });
  const supported = new Set(resolver.languages);
  const mailField = options.mailField || 'emailLang';
  const interfaceFields = options.interfaceFields || ['lang'];
  const followValue = options.followValue === undefined ? 'auto' : options.followValue;

  /** A stored value we serve, or null — never a tag we would then mis-render. */
  const served = (value) => {
    const tag = base(value);
    return supported.has(tag) ? tag : null;
  };

  /**
   * @param {object|null} recipient the account being written to.
   * @param {object} [req] the request that triggered the send, if any — its
   *   Accept-Language is the last resort, for a public form with no account.
   * @returns {string} always one of `languages`.
   */
  function languageOf(recipient, req) {
    if (recipient && typeof recipient === 'object') {
      /* The mail choice wins over the interface: that is the whole point of
         having it. "auto" chooses nothing and lets the interface decide. A
         value we do not serve falls through rather than forcing the default —
         the interface language is a better guess than none. */
      const chosen = pick(recipient, mailField);
      if (chosen && chosen !== followValue) {
        const language = served(chosen);
        if (language) return language;
      }
      for (const field of interfaceFields) {
        const language = served(pick(recipient, field));
        if (language) return language;
      }
    }
    return resolver.resolveLanguage(req);
  }

  /** What a settings endpoint should accept: every language, plus "follow". */
  const choices = followValue ? [followValue, ...resolver.languages] : [...resolver.languages];

  /**
   * Refuse an unknown value rather than storing it. An account saved with a
   * language nobody serves gets its mail in the fallback, and nobody sees why
   * until they read the first one.
   */
  const isChoice = (value) => choices.includes(value);

  return {
    languages: resolver.languages,
    defaultLanguage: resolver.defaultLanguage,
    languageOf,
    choices,
    isChoice,
    /** The fields a reload MUST select for languageOf to see anything. */
    fields: [mailField, ...interfaceFields].map((field) => field.split('.')[0])
  };
}

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * Re-read a recipient with the fields a mail needs.
 *
 * The loader is yours — a database lookup, an HTTP call — and receives the
 * exact field list to select, so the projection can no longer drift away from
 * what the resolver reads.
 *
 * It never throws. An account that cannot be read still gets its mail, in the
 * fallback language: a mail in the wrong language beats no mail at all, and
 * the thing it is about (a reset, a code) has usually already happened.
 *
 * @param {object} options
 * @param {Function} options.load async (id, fields, context) => account|null.
 * @param {string[]} [options.fields] fields the mail needs (email, name…).
 * @param {object} [options.language] from createRecipientLanguage(): its
 *   fields are added to `fields`, so forgetting them is impossible.
 * @param {object} [options.logger]
 */
function createRecipientReloader(options = {}) {
  const load = options.load;
  if (typeof load !== 'function') {
    throw new Error('createRecipientReloader requires options.load.');
  }

  const fields = [...new Set([...(options.fields || []), ...((options.language && options.language.fields) || [])])];
  if (!fields.length) {
    throw new Error('createRecipientReloader needs options.fields or options.language — a reload that selects nothing is the bug it exists to prevent.');
  }

  const logger = options.logger || NOOP_LOGGER;

  const idOf = (ref) => {
    if (ref == null) return null;
    if (typeof ref !== 'object') return ref;
    return ref.id ?? ref._id ?? null;
  };

  /**
   * @param {string|object} ref an id, or a partial recipient (a session user,
   *   a token payload) carrying `id` or `_id`.
   * @param {*} [context] passed to the loader — a role, a tenant, a model name.
   * @returns {Promise<object|null>} the stored account, with whatever the
   *   partial carried underneath it. What the STORE says wins: a token can hold
   *   a stale address, never a fresher one.
   */
  async function reload(ref, context) {
    const partial = ref && typeof ref === 'object' ? ref : null;
    const id = idOf(ref);
    if (id == null || id === '') return partial;

    let account = null;
    try {
      account = await load(id, fields, context);
    } catch (error) {
      logger.warn?.(`[recipient] account ${id} could not be read — mail falls back to the default language: ${error.message}`);
    }

    if (!account) return partial;
    return partial ? { ...partial, ...account } : account;
  }

  return { reload, fields };
}

module.exports = { createRecipientLanguage, createRecipientReloader };
