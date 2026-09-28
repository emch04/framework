/**
 * Masking what identifies people before a text leaves for an outside provider,
 * and putting it back in the answer.
 *
 * The prompt was masked; the web search was not. The model wrote the search
 * query from the masked question, the loop unmasked the tool parameters for
 * the tools that need real names — and the child's name went to the search
 * engine in clear. So the rule here is about DIRECTION, not about which tool:
 * whatever leaves the machine is masked at the moment it leaves, and only what
 * comes back is unmasked.
 *
 * One masker per conversation. It LEARNS: a name found once (in the school's
 * register, by a pattern, by an entity detector) is masked everywhere after,
 * with the same token, so the model can still tell two people apart.
 *
 * Choices kept from real use:
 *
 *   - register names match CASE-SENSITIVELY and on whole words. "Grace",
 *     "Chance" and "Merveille" are real first names; "grâce à" and "la chance"
 *     must survive. A common word damaged costs less than a child's name in
 *     clear, but the case keeps most sentences intact;
 *   - a name shorter than three letters identifies no one and breaks sentences;
 *   - a register name absent from the text creates NO token — a register of a
 *     thousand names must not pollute the unmasking table;
 *   - models drop the leading "#" of a token; unmasking tolerates it;
 *   - tokens are replaced longest first, on token boundaries, so #PERSON_0001
 *     never eats the start of #PERSON_00012.
 */

const DEFAULT_MIN_LENGTH = 3;
const DEFAULT_MIN_SCORE = 0.6;
const DEFAULT_DETECT_MAX_CHARS = 1500;

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const escape = (text) => String(text).replace(ESCAPE, '\\$&');
const LEXICAL = '\\p{L}\\p{N}\\p{M}_';

const defaultToken = (type, sequence) => `#${String(type || 'ENTITY').toUpperCase()}_${String(sequence).padStart(4, '0')}`;

/** At most `max` characters, cut on a blank: a name is never sliced in two. */
function headWithoutCuttingWords(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const blank = cut.search(/\s\S*$/);
  return blank > 0 ? cut.slice(0, blank) : cut;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.names]     register names, masked case-sensitively.
 * @param {Array<{type: string, pattern: RegExp}>} [options.patterns] global
 *   regexes for structured data (e-mail, phone…), masked as found.
 * @param {Function} [options.detect]    async (text) => [{ text, type, score }] — an
 *   entity detector (a local NER model). Its absence, or a null answer, leaves
 *   the register and the patterns alone.
 * @param {string[]} [options.detectTypes] which detected types to mask. Default ['person'].
 * @param {number} [options.minScore]    detections under this are ignored. Default 0.6 —
 *   a false name masked damages the sentence sent to the model.
 * @param {number} [options.detectMaxChars] text handed to the detector, cut on a blank. Default 1500.
 * @param {number} [options.minLength]   shortest value masked. Default 3.
 * @param {Function} [options.token]     (type, sequence) => string. Default "#TYPE_0001".
 * @param {Function} [options.typeOf]    (value) => type for register names. Default 'PERSON'.
 * @param {Function} [options.keep]      (value) => true to never mask it (a product name…).
 */
function createReversibleMasker(options = {}) {
  const minLength = options.minLength || DEFAULT_MIN_LENGTH;
  const minScore = options.minScore === undefined ? DEFAULT_MIN_SCORE : options.minScore;
  const detectMaxChars = options.detectMaxChars || DEFAULT_DETECT_MAX_CHARS;
  const detect = typeof options.detect === 'function' ? options.detect : null;
  const detectTypes = new Set(options.detectTypes || ['person']);
  const tokenFor = options.token || defaultToken;
  const typeOf = options.typeOf || (() => 'PERSON');
  const keep = options.keep || (() => false);
  const patterns = (options.patterns || []).map(({ type, pattern }) => {
    if (!(pattern instanceof RegExp) || !pattern.global) {
      throw new Error('createReversibleMasker: every pattern must be a global RegExp.');
    }
    return { type, pattern };
  });

  /* token -> real value ; real value -> token */
  const byToken = new Map();
  const byValue = new Map();
  /* values matched case-insensitively (patterns: an e-mail is an e-mail in any case) */
  const loose = new Set();
  const register = new Set();
  let sequence = 0;

  const looksLikeToken = (value) => byToken.has(value) || byToken.has(`#${value}`);
  const alreadyMasked = /#[A-Z]+_\d+/;

  function tokenOf(value, type) {
    if (byValue.has(value)) return byValue.get(value);
    let token;
    do {
      sequence += 1;
      token = tokenFor(type, sequence);
    } while (byToken.has(token));
    byToken.set(token, value);
    byValue.set(value, token);
    return token;
  }

  function acceptable(value) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (text.length < minLength) return null;
    if (alreadyMasked.test(text) || looksLikeToken(text)) return null;
    if (keep(text)) return null;
    return text;
  }

  function replaceWhole(text, value, token, caseSensitive) {
    const regex = new RegExp(`(^|[^${LEXICAL}])(${escape(value)})(?=$|[^${LEXICAL}])`, caseSensitive ? 'gu' : 'giu');
    return text.replace(regex, (_whole, prefix) => `${prefix}${token}`);
  }

  function learn(names, type) {
    for (const raw of names || []) {
      const value = acceptable(raw);
      if (value) register.add(value);
      if (value && type) typeOverride.set(value, type);
    }
  }
  const typeOverride = new Map();
  learn(options.names);

  /** Mask a string with everything known so far, plus `names` for this call. */
  function mask(text, { names } = {}) {
    if (typeof text !== 'string' || !text) return text;
    if (names) learn(names);
    let out = text;

    /* Structured data first, on the intact text. */
    for (const { type, pattern } of patterns) {
      pattern.lastIndex = 0;
      for (const match of out.matchAll(pattern)) {
        const value = acceptable(match[0]);
        if (!value) continue;
        tokenOf(value, type);
        loose.add(value);
      }
    }

    /* Longest first: "Marie Kabongo" before "Marie". Case-sensitive for the
       register; a value absent from the text creates no token. */
    const candidates = [...new Set([...register, ...byValue.keys()])].sort((a, b) => b.length - a.length);
    for (const value of candidates) {
      const caseSensitive = !loose.has(value);
      const present = caseSensitive ? out.includes(value) : out.toLowerCase().includes(value.toLowerCase());
      if (!present) continue;
      const token = tokenOf(value, typeOverride.get(value) || typeOf(value));
      out = replaceWhole(out, value, token, caseSensitive);
    }
    return out;
  }

  /**
   * Names the detector finds, for the register — deduplicated, filtered by
   * type, score and length; tokens already placed are not names.
   */
  async function detectNames(text) {
    if (!detect || typeof text !== 'string' || !text.trim()) return [];
    let found;
    try {
      found = await detect(headWithoutCuttingWords(text, detectMaxChars));
    } catch (_error) {
      return [];
    }
    if (!Array.isArray(found)) return [];
    const names = found
      .filter((entity) => entity && detectTypes.has(entity.type) && typeof entity.score === 'number' && entity.score >= minScore)
      .map((entity) => acceptable(entity.text))
      .filter(Boolean);
    return [...new Set(names)];
  }

  /** Detect, learn, then mask. The detector sees the text in clear — keep it local. */
  async function maskAsync(text, opts = {}) {
    if (typeof text !== 'string' || !text) return text;
    const detected = await detectNames(text);
    return mask(text, { names: [...(opts.names || []), ...detected] });
  }

  /** Every string of a structure, masked. Keys are left alone. */
  function maskDeep(value) {
    if (typeof value === 'string') return mask(value);
    if (Array.isArray(value)) return value.map(maskDeep);
    if (value instanceof Date) return new Date(value.getTime());
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, maskDeep(child)]));
    }
    return value;
  }

  function unmask(text) {
    if (typeof text !== 'string' || !text || !byToken.size) return text;
    let out = text;
    const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
    for (const token of tokens) {
      const value = byToken.get(token);
      const variants = token.startsWith('#') ? [token, token.slice(1)] : [token];
      for (const variant of variants) {
        if (!out.includes(variant)) continue;
        const regex = new RegExp(`(^|[^${LEXICAL}#])(${escape(variant)})(?![${LEXICAL}])`, 'gu');
        out = out.replace(regex, (_whole, prefix) => `${prefix}${value}`);
      }
    }
    return out;
  }

  function unmaskDeep(value) {
    if (typeof value === 'string') return unmask(value);
    if (Array.isArray(value)) return value.map(unmaskDeep);
    if (value instanceof Date) return new Date(value.getTime());
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unmaskDeep(child)]));
    }
    return value;
  }

  /**
   * Unmask a stream of chunks. A token can straddle two chunks ("#PERS" then
   * "ON_0001"); the tail that could still be the start of a token is held
   * back until the next chunk decides.
   */
  async function* unmaskStream(chunks) {
    let carry = '';
    const longest = () => Math.max(0, ...[...byToken.keys()].map((token) => token.length));
    for await (const chunk of chunks) {
      const text = carry + String(chunk);
      const hold = holdBack(text, longest());
      carry = text.slice(text.length - hold);
      const ready = text.slice(0, text.length - hold);
      if (ready) yield unmask(ready);
    }
    if (carry) yield unmask(carry);
  }

  function holdBack(text, maxLength) {
    if (!maxLength) return 0;
    const tokens = [...byToken.keys()].flatMap((token) => (token.startsWith('#') ? [token, token.slice(1)] : [token]));
    for (let size = Math.min(maxLength, text.length); size > 0; size -= 1) {
      const tail = text.slice(text.length - size);
      /* A whole token at the very end may still be followed by a digit that
         makes it another token: hold it too. */
      if (tokens.some((token) => token.startsWith(tail))) return size;
    }
    return 0;
  }

  return {
    mask,
    maskAsync,
    maskDeep,
    unmask,
    unmaskDeep,
    unmaskStream,
    detectNames,
    /** How many values are masked so far — never the values. */
    size: () => byToken.size
  };
}

/**
 * Wrap an outside call so its input is masked on the way out and its answer
 * unmasked on the way back.
 */
function withOutboundMasking(masker, call) {
  if (!masker || typeof masker.maskAsync !== 'function' || typeof masker.unmaskDeep !== 'function') {
    throw new Error('withOutboundMasking requires a masker from createReversibleMasker().');
  }
  if (typeof call !== 'function') throw new Error('withOutboundMasking requires a function to wrap.');
  return async (input, ...rest) => {
    const outbound = typeof input === 'string' ? await masker.maskAsync(input) : masker.maskDeep(input);
    return masker.unmaskDeep(await call(outbound, ...rest));
  };
}

module.exports = { createReversibleMasker, withOutboundMasking, headWithoutCuttingWords };
