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
 * Sensible defaults. Deliberately conservative: a false positive costs you a
 * redacted string in a log, a false negative costs you a leak.
 */
const DEFAULT_PATTERNS = [
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
  /* Long digit runs, with the usual separators. Deliberately loose: a phone
     number's shape changes with every country, and missing one is worse than
     redacting an order number. */
  { name: 'phone', pattern: /(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g, replacement: '[PHONE]' },
  { name: 'card', pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, replacement: '[CARD]' },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: 'Bearer [REDACTED]' },
  /* `secret: "abc"` inside a free-text line — the shape a stringified payload
     takes when someone logs it whole. */
  {
    name: 'inline-secret',
    pattern: /\b(password|passwd|secret|api[_-]?key|token|authorization|credential)\b(["']?\s*[:=]\s*["']?)([^"'\s,;}]+)/gi,
    replacement: (_match, label, separator) => `${label}${separator}[REDACTED]`
  }
];

/** Field names whose VALUE is always a secret, whatever it looks like. */
const DEFAULT_SECRET_KEYS = [
  'password', 'passwd', 'pass', 'secret', 'token', 'accesstoken', 'refreshtoken',
  'apikey', 'api_key', 'authorization', 'cookie', 'sessionid', 'privatekey', 'credential'
];

/**
 * @param {object} [options]
 * @param {Array} [options.patterns]   replaces the defaults entirely.
 * @param {Array} [options.extra]      added to the defaults.
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
  const secretKeys = new Set((options.secretKeys || DEFAULT_SECRET_KEYS).map((key) => key.toLowerCase()));
  const mask = options.mask || '[REDACTED]';
  const maxDepth = options.maxDepth === undefined ? 12 : options.maxDepth;

  function redactString(text) {
    let out = String(text);
    for (const { pattern, replacement } of patterns) {
      /* A global regex carries lastIndex between calls; reusing one without
         resetting it skips matches on every second string. */
      pattern.lastIndex = 0;
      out = out.replace(pattern, replacement);
    }
    return out;
  }

  function walk(value, depth, seen) {
    if (depth > maxDepth) return '[TRUNCATED]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object') return value;

    /* A structure that points back at itself would otherwise loop until the
       stack runs out — and logging is exactly where that happens. */
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
    if (value instanceof Date) return value;
    if (value instanceof Error) {
      return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
    }

    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      /* The KEY is left alone — renaming a field breaks whoever reads the log
         looking for it. Only the value goes. */
      out[key] = secretKeys.has(key.toLowerCase()) ? mask : walk(entry, depth + 1, seen);
    }
    return out;
  }

  /** Redact a string, an object, an array — anything you were about to log. */
  function redact(data) {
    return walk(data, 0, new WeakSet());
  }

  return { redact, redactString, patterns, secretKeys: [...secretKeys] };
}

module.exports = { createRedactor, DEFAULT_PATTERNS, DEFAULT_SECRET_KEYS };
