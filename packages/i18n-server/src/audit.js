/**
 * The test that keeps error messages readable by the people who read them.
 *
 * Error messages are read by customers, parents, shopkeepers — not by the team
 * that wrote them. Left alone they drift towards the terminal: "invalid
 * payload", "token expired", "not found". Each one is accurate and each one
 * leaves the reader with nothing to do.
 *
 * This is not a style checker. It looks for two concrete failures: words that
 * only exist for a developer, and sentences so short they teach nothing. Run it
 * as a test in your own suite, and the rule enforces itself from then on —
 * which is the part worth copying, more than the code.
 */
const fs = require('fs');
const path = require('path');

/**
 * Words a non-technical reader cannot act on. A starting point, not a law:
 * every product has its own vocabulary to ban.
 */
const DEFAULT_JARGON = [
  /\btoken\b/i,
  /\bpayload\b/i,
  /\bendpoint\b/i,
  /\bnull\b/,
  /\bundefined\b/,
  /\bexception\b/i,
  /\bstack ?trace\b/i,
  /\bJWT\b/,
  /\bUUID\b/i,
  /validation failed/i,
  /\bERR_[A-Z_]+\b/,
  /\b[a-z]+Id\b/
];

/**
 * Walk a source tree and pull out the user-facing strings.
 *
 * The extraction pattern is yours, because the call shape is yours. It must
 * expose the message as its first capture group.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {RegExp} options.pattern must carry the `g` flag and one capture group.
 * @param {string[]} [options.extensions] default ['.js']
 * @param {string[]} [options.ignore] directory names to skip.
 */
function collectMessages(options = {}) {
  const root = options.root;
  if (!root) throw new Error('collectMessages requires options.root.');

  const pattern = options.pattern;
  if (!(pattern instanceof RegExp) || !pattern.global) {
    throw new Error('collectMessages requires options.pattern to be a global RegExp with one capture group.');
  }

  const extensions = options.extensions || ['.js'];
  const ignore = new Set(options.ignore || ['node_modules', '.git', 'dist', 'build', 'coverage']);

  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignore.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;

      const source = fs.readFileSync(full, 'utf8');
      /* A shared regex carries its own lastIndex between files; resetting it
         is the difference between scanning everything and scanning half. */
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source))) {
        found.push({ file: path.relative(root, full), message: match[1] });
      }
    }
  };

  walk(root);
  return found;
}

/**
 * @param {object} [options]
 * @param {RegExp[]} [options.jargon]  patterns to ban. Defaults to DEFAULT_JARGON.
 * @param {number} [options.minWords]  shortest acceptable sentence. Default 3.
 * @param {string[]} [options.allow]   exact messages exempted, for the rare
 *   case where the technical word IS the clearest one.
 */
function createMessageAudit(options = {}) {
  const jargon = options.jargon || DEFAULT_JARGON;
  const minWords = options.minWords === undefined ? 3 : options.minWords;
  const allow = new Set(options.allow || []);

  /**
   * @param {Array<{file?: string, message: string}>} entries
   * @returns {{jargon: object[], tooShort: object[], clean: boolean}}
   */
  function inspect(entries = []) {
    const withJargon = [];
    const tooShort = [];

    for (const entry of entries) {
      const message = String(entry.message || '');
      if (allow.has(message)) continue;

      const offending = jargon.filter((pattern) => pattern.test(message));
      if (offending.length) {
        withJargon.push({ ...entry, matched: offending.map(String) });
      }

      if (message.trim().split(/\s+/).filter(Boolean).length < minWords) {
        tooShort.push({ ...entry });
      }
    }

    return { jargon: withJargon, tooShort, clean: !withJargon.length && !tooShort.length };
  }

  /** One readable block per finding — what a failing test should print. */
  function describe(findings) {
    const lines = [];
    for (const finding of findings.jargon) {
      lines.push(`${finding.file || '?'} — developer word in: "${finding.message}"`);
    }
    for (const finding of findings.tooShort) {
      lines.push(`${finding.file || '?'} — says too little: "${finding.message}"`);
    }
    return lines;
  }

  return { inspect, describe, jargon, minWords };
}

module.exports = { createMessageAudit, collectMessages, DEFAULT_JARGON };
