/**
 * Keeping personal data out of your logs.
 *
 * Logs get shipped to a third party, kept for months, and read by whoever has
 * access to the dashboard. An email address or a phone number that lands there
 * has left your system, whatever your privacy policy says.
 *
 * The redaction walks the structure rather than stringifying it. Serialising an
 * object, running regexes over the JSON and parsing it back is quicker to write
 * and quietly wrong: it rewrites KEYS as well as values, and a replacement
 * containing a quote or a brace corrupts the document it was meant to clean.
 */

/**
 * Luhn checksum — the check digit every payment card carries.
 *
 * Without it, "13 to 19 digits" is also every millisecond timestamp and most
 * order numbers: the card rule either fires on half the log or is dropped.
 */
function luhnValid(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * ISO 13616 mod-97 check. An IBAN-shaped string that fails it is a product
 * code or a reference, not a bank account — leave it readable.
 */
function ibanValid(value) {
  const compact = String(value).replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    /* Letters become two digits (A=10…Z=35). Folding the remainder as we go
       avoids BigInt and stays exact for a 34-character IBAN. */
    const chunk = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of chunk) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/* A calendar date, optionally with its hour, is the most common digit run in
   a log line. The loose phone rule used to eat "2026-09-19 10" and leave
   ":00:00" behind — a false positive that destroyed every timestamp. */
const LOOKS_LIKE_DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2})?$/;

/*
 * Field labels whose value is a secret when written inline ("token=…").
 * Matched as a SUFFIX of a longer identifier too: `\btoken\b` alone never
 * fired on "access_token=…", because "_" is a word character — the single
 * most common secret in an OAuth log line leaked through.
 */
const SECRET_LABEL = '[A-Za-z0-9_-]*?(?:password|passwd|pwd|secret|api[_-]?key|private[_-]?key|access[_-]?key|token|authorization|credential|cookie)(?:[_-]?(?:key|hash))?';

/**
 * The generic set — shapes that are the same in every country and language.
 * National identifiers, local phone formats and document numbers are yours to
 * add through `extra`.
 *
 * ORDER MATTERS: specific before generic. A JWT contains digits, a card number
 * is a digit run, an IBAN is too; the loose phone rule runs LAST so that the
 * rules able to prove what they found get the first word.
 *
 * Deliberately conservative: a false positive costs you a redacted string in a
 * log, a false negative costs you a leak.
 */
const DEFAULT_PATTERNS = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[PRIVATE KEY]'
  },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: 'Bearer [REDACTED]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, replacement: '[JWT]' },
  /* Provider keys carry a recognisable prefix precisely so scanners can find
     them. Not using it means relying on the key sitting next to a label. */
  {
    name: 'provider-key',
    pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}/g,
    replacement: '[API KEY]'
  },
  /* https://user:password@host — the password would otherwise survive, and the
     email rule would mangle the rest into something misleading. */
  {
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replacement: (_match, scheme) => `${scheme}[REDACTED]@`
  },
  /* `secret: "abc"` inside a free-text line — the shape a stringified payload
     takes when someone logs it whole. A value that is already a mask
     ("[API KEY]") is skipped — re-masking it cut the placeholder in half. Only
     this set's own placeholders count: a password that merely looks like
     "[ABC]" must still go. */
  {
    name: 'inline-secret',
    pattern: new RegExp(`\\b(${SECRET_LABEL})(["']?\\s*[:=]\\s*["']?)(?!\\[(?:REDACTED|API KEY|JWT|PRIVATE KEY)\\])([^"'\\s,;}]+)`, 'gi'),
    replacement: (_match, label, separator) => `${label}${separator}[REDACTED]`
  },
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
  {
    name: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g,
    replacement: '[IBAN]',
    validate: ibanValid
  },
  {
    name: 'card',
    pattern: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
    replacement: '[CARD]',
    validate: luhnValid
  },
  /* Long digit runs, with the usual separators. Deliberately loose: a phone
     number's shape changes with every country, and missing one is worse than
     redacting an order number. The lookbehind refuses a run glued to a word,
     a dot or a hyphen — otherwise the last group of every UUID in a request
     log became "[PHONE]". */
  {
    name: 'phone',
    pattern: /(?<![\w.-])\+?\d[\d\s().-]{7,}\d(?![\w.])/g,
    replacement: '[PHONE]',
    validate: (match) => !LOOKS_LIKE_DATE.test(match)
  }
];

/** Field names whose VALUE is always a secret, whatever it looks like. */
const DEFAULT_SECRET_KEYS = [
  'password', 'passwd', 'pass', 'secret', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'apikey', 'api_key', 'xapikey', 'clientsecret', 'secretkey', 'authorization', 'cookie', 'setcookie',
  'sessionid', 'privatekey', 'credential', 'otp'
];

/* "access_token", "accessToken" and "Access-Token" are one field written three
   ways. Comparing raw names let two of the three through. */
const normaliseKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * @param {object} [options]
 * @param {Array} [options.patterns]   replaces the defaults entirely.
 * @param {Array} [options.extra]      added to the defaults, and run first.
 *   Each pattern: { name?, pattern: RegExp (global), replacement, validate? }.
 *   `validate(match) => boolean` vets a match before it is replaced: false
 *   leaves the text for the rules that follow.
 * @param {string[]} [options.secretKeys] field names always redacted by name.
 * @param {string} [options.mask]      what a redacted-by-name value becomes.
 * @param {number} [options.maxDepth]  guard against cyclic or absurd structures.
 */
function createRedactor(options = {}) {
  /*
   * `extra` runs BEFORE the defaults, and the order is the whole point.
   *
   * The default patterns are deliberately loose — the phone one matches any
   * long run of digits. A caller adding a pattern for their own identifier
   * format ("MAT-2026-0001") expects it to win; run after, it never fires,
   * because the generic rule already ate the digits.
   *
   * Specific before generic.
   */
  const patterns = [...(options.extra || []), ...(options.patterns || DEFAULT_PATTERNS)];
  for (const entry of patterns) {
    /* A non-global regex replaces the FIRST match and silently keeps every
       other one: a line with two e-mail addresses would leak the second. */
    if (!entry || !(entry.pattern instanceof RegExp) || !entry.pattern.global) {
      throw new Error(`createRedactor: pattern "${entry && entry.name ? entry.name : '?'}" must be a global RegExp.`);
    }
  }
  const secretKeys = new Set((options.secretKeys || DEFAULT_SECRET_KEYS).map(normaliseKey));
  const mask = options.mask || '[REDACTED]';
  const maxDepth = options.maxDepth === undefined ? 12 : options.maxDepth;

  function applyPattern(text, entry, onHit) {
    const { pattern, replacement, validate } = entry;
    /* A global regex carries lastIndex between calls; reusing one without
       resetting it skips matches on every second string. */
    pattern.lastIndex = 0;
    return text.replace(pattern, (...args) => {
      const match = args[0];
      if (validate && !validate(match)) return match;
      if (onHit) onHit(entry);
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  }

  function redactString(text, onHit) {
    let out = String(text);
    for (const entry of patterns) out = applyPattern(out, entry, onHit);
    return out;
  }

  function walk(value, depth, seen, onHit) {
    if (depth > maxDepth) return '[TRUNCATED]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value, onHit);
    if (typeof value !== 'object') return value;

    /* A structure that points back at itself would otherwise loop until the
       stack runs out — and logging is exactly where that happens. */
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen, onHit));
    if (value instanceof Date) return value;
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message, onHit),
        stack: value.stack ? redactString(value.stack, onHit) : undefined
      };
    }

    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      /* The KEY is left alone — renaming a field breaks whoever reads the log
         looking for it. Only the value goes. */
      if (secretKeys.has(normaliseKey(key))) {
        if (onHit) onHit({ name: 'secret-key' });
        out[key] = mask;
      } else {
        out[key] = walk(entry, depth + 1, seen, onHit);
      }
    }
    return out;
  }

  /** Redact a string, an object, an array — anything you were about to log. */
  function redact(data) {
    return walk(data, 0, new WeakSet());
  }

  /**
   * Redact AND say what was found — the counts by rule name, never the values.
   *
   * Before a message leaves for a third party (an AI provider, a support
   * tool), "we masked two cards" is what an audit trail or a block decision
   * needs; the masked text alone cannot tell a clean message from a cleaned one.
   */
  function inspect(data) {
    const found = {};
    const value = walk(data, 0, new WeakSet(), (entry) => {
      const name = entry.name || 'unnamed';
      found[name] = (found[name] || 0) + 1;
    });
    return { value, found, clean: Object.keys(found).length === 0 };
  }

  return { redact, redactString: (text) => redactString(text), inspect, patterns, secretKeys: [...secretKeys] };
}

module.exports = { createRedactor, DEFAULT_PATTERNS, DEFAULT_SECRET_KEYS, luhnValid, ibanValid };
