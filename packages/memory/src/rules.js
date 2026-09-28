/**
 * What may become a memory, and how loose model output is read.
 *
 * Every refusal is a code, never a sentence: the words shown to a person come
 * from the consumer's own catalog. Content rules (health, secrets, whatever a
 * product must never keep) are injected — this file only knows the structural
 * ones: empty, too long, unknown kind, kind not allowed for a role, and the
 * name of somebody else.
 */

const REASONS = Object.freeze({
  EMPTY: 'empty',
  TOO_LONG: 'too_long',
  INVALID_KIND: 'invalid_kind',
  KIND_NOT_ALLOWED: 'kind_not_allowed',
  OTHER_PERSON: 'other_person',
  PAUSED: 'paused',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  AI_DISABLED: 'ai_disabled'
});

/** Accents off, lower case: "José" and "JOSE" are the same name. */
function fold(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
}

/** Letters and digits only, one space between words. */
function wordsOf(value) {
  return fold(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/*
 * A memory is plain words. Models write it with their Markdown (**bold**,
 * `code`, a heading) — that is removed. A single underscore or hash is left
 * alone: "C#" and "snake_case" are words too.
 */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\*+|`+|_{2,}/g, '')
    .replace(/^\s*#+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * Models answer with the kind in capitals, in another language, with an
 * accent. The kind is folded and looked up in the kinds, then in the
 * consumer's aliases. Unknown → `fallback` (null by default: refused).
 */
function normalizeKind(value, { kinds, aliases = {}, fallback = null } = {}) {
  const key = fold(String(value ?? '').trim());
  if (!key) return fallback;
  const direct = (kinds || []).find((kind) => fold(kind) === key);
  if (direct) return direct;
  for (const [alias, kind] of Object.entries(aliases)) {
    if (fold(alias) === key && (kinds || []).includes(kind)) return kind;
  }
  return fallback;
}

/* "4", 4.4 and 4 all mean 4; out of range is clamped; nonsense is the fallback. */
function normalizeImportance(value, fallback = 3) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(5, Math.max(1, Math.round(number))) : fallback;
}

/*
 * Whole words only: a registered "Paul" is not found inside "Pauline", and a
 * name shorter than three letters never matches (too many false alarms).
 */
function mentionsName(text, name) {
  const target = wordsOf(name);
  if (target.length < 3) return false;
  return ` ${wordsOf(text)} `.includes(` ${target} `);
}

/**
 * A content rule built from patterns. Each pattern is tested on the raw text
 * AND on its folded form, so a pattern written without accents still matches
 * "santé", and one written with them still matches.
 *
 * @param {object} options
 * @param {string} options.code             the refusal code returned.
 * @param {RegExp[]} options.patterns
 * @param {string[]} [options.roles]        apply to these roles only.
 * @param {string[]} [options.exceptRoles]  never apply to these roles.
 * @param {boolean} [options.allowWhenExplicit] the person asked for this
 *   exact thing to be remembered: let it through.
 */
function patternRule({ code, patterns, roles, exceptRoles, allowWhenExplicit = false } = {}) {
  if (!code) throw new Error('patternRule requires a code.');
  if (!Array.isArray(patterns) || !patterns.length) throw new Error('patternRule requires patterns.');
  return function rule(candidate) {
    if (roles && !roles.includes(candidate.role)) return null;
    if (exceptRoles && exceptRoles.includes(candidate.role)) return null;
    if (allowWhenExplicit && candidate.explicit) return null;
    const raw = candidate.text;
    const folded = fold(raw);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(raw)) return code;
      pattern.lastIndex = 0;
      if (pattern.test(folded)) return code;
    }
    return null;
  };
}

/**
 * The full check, in order: structure, kind, the consumer's rules, then names.
 * Returns a refusal code, or null when the memory may be kept.
 *
 * `alreadyPresent` is the text a memory carried before an edit: a name it
 * already held was accepted with it and is not refused again. Only a name
 * ADDED by the edit is.
 */
async function checkCandidate(candidate, config) {
  const { text, kind, role } = candidate;
  if (!text) return REASONS.EMPTY;
  if (text.length > config.maxTextLength) return REASONS.TOO_LONG;
  if (!kind || !config.kinds.includes(kind)) return REASONS.INVALID_KIND;
  const allowed = role !== undefined && role !== null ? config.roleKinds[role] : undefined;
  if (Array.isArray(allowed) && !allowed.includes(kind)) return REASONS.KIND_NOT_ALLOWED;

  for (const rule of config.rules) {
    const code = await rule(candidate);
    if (code) return String(code);
  }

  const own = wordsOf(candidate.personName || '');
  const before = candidate.alreadyPresent || '';
  for (const name of candidate.names || []) {
    if (own && wordsOf(name) === own) continue;
    if (before && mentionsName(before, name)) continue;
    if (mentionsName(text, name)) return REASONS.OTHER_PERSON;
  }
  return null;
}

module.exports = {
  REASONS,
  fold,
  wordsOf,
  cleanText,
  normalizeKind,
  normalizeImportance,
  mentionsName,
  patternRule,
  checkCandidate
};
