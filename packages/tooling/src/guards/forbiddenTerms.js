/**
 * Words a product must not say — in prompts, catalogs, emails, UI copy.
 *
 * The defect: a product sold everywhere carries one region, one regulator or
 * one payment operator in its hard-coded text, so every other customer reads
 * a product that was not made for them. The adaptation belongs in per-country
 * DATA, not in the sentence.
 *
 * Negation does not count. "This is not only for <region>" still names the
 * region: a language model reads the words, not the intent of the sentence
 * around them, and a customer skimming does the same. So there is no
 * "unless negated" escape here — only explicit, named `allow` entries.
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_SKIPPED_DIRS, lineNumberAt, resolveProjectPath, walkFiles } = require('../fsUtils');
const { escapeRegExp } = require('./sourceScan');

/*
 * A string term is a WHOLE WORD, case-insensitive, Unicode-aware. Substring
 * matching looks safer and is not: a two- or three-letter acronym turns up
 * inside ordinary words ("hardcoded" contains "rdc"). Use a RegExp for stems.
 * Spaces in a term match any whitespace, so a line break does not hide it.
 */
function compileTerm(term, index) {
  const entry = term instanceof RegExp || typeof term === 'string' ? { pattern: term } : term;
  if (!entry || (typeof entry.pattern !== 'string' && !(entry.pattern instanceof RegExp))) {
    throw new Error(`findForbiddenTerms: terms[${index}] must be a string, a RegExp or { pattern, reason }.`);
  }

  if (entry.pattern instanceof RegExp) {
    const flags = entry.pattern.flags.includes('g') ? entry.pattern.flags : `${entry.pattern.flags}g`;
    return { label: String(entry.pattern), reason: entry.reason, regex: new RegExp(entry.pattern.source, flags) };
  }

  const words = entry.pattern.trim();
  if (!words) {
    throw new Error(`findForbiddenTerms: terms[${index}] is empty.`);
  }
  const body = words.split(/\s+/).map(escapeRegExp).join('\\s+');
  return {
    label: words,
    reason: entry.reason,
    regex: new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu')
  };
}

function compileAllowed(allow) {
  return (allow || []).map((entry) => {
    const pattern = entry instanceof RegExp || typeof entry === 'string' ? entry : entry && entry.pattern;
    if (typeof pattern === 'string') return (text) => text.toLowerCase().includes(pattern.toLowerCase());
    if (pattern instanceof RegExp) return (text) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text);
    throw new Error('findForbiddenTerms: allow entries must be strings, RegExps or { pattern, reason }.');
  });
}

function normalizeTexts(texts) {
  if (typeof texts === 'string') return [{ name: 'text', text: texts }];
  if (Array.isArray(texts)) return texts.map((entry, index) => (typeof entry === 'string' ? { name: `text[${index}]`, text: entry } : entry));
  return Object.entries(texts || {}).map(([name, text]) => ({ name, text }));
}

/**
 * @param {string|string[]|Record<string,string>|Array<{name,text}>} texts
 * @param {Array<string|RegExp|{pattern, reason?}>} terms
 * @param {object} [options]
 * @param {Array<string|RegExp|{pattern, reason?}>} [options.allow] phrases in
 *   which a forbidden term is legitimate (a product name, a quoted law). The
 *   check runs on the matched LINE, so the allowance stays local.
 * @param {Array<string|RegExp>} [options.required] terms each text MUST
 *   contain — forbidding the narrow wording is half the rule, keeping the
 *   broad one is the other half.
 */
function findForbiddenTerms(texts, terms, options = {}) {
  const compiled = (terms || []).map(compileTerm);
  const allowed = compileAllowed(options.allow);
  const required = (options.required || []).map(compileTerm);
  const findings = [];
  const missing = [];

  for (const { name, text } of normalizeTexts(texts)) {
    const content = String(text ?? '');

    for (const term of compiled) {
      term.regex.lastIndex = 0;
      let match;
      while ((match = term.regex.exec(content))) {
        if (match[0] === '') {
          term.regex.lastIndex++;
          continue;
        }
        const lineStart = content.lastIndexOf('\n', match.index) + 1;
        const lineEnd = content.indexOf('\n', match.index);
        const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
        if (allowed.some((isAllowed) => isAllowed(line))) continue;

        findings.push({
          source: name,
          term: term.label,
          reason: term.reason,
          match: match[0],
          line: lineNumberAt(content, match.index),
          excerpt: line.trim().slice(0, 160)
        });
      }
    }

    for (const term of required) {
      term.regex.lastIndex = 0;
      if (!term.regex.test(content)) missing.push({ source: name, term: term.label, reason: term.reason });
    }
  }

  return { ok: !findings.length && !missing.length, findings, missing };
}

/**
 * Same check over files on disk. Tests and fixtures are skipped by default:
 * they quote forbidden words on purpose, to forbid them.
 */
function findForbiddenTermsInFiles(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const include = options.include || ((name) => /\.(?:json|md|txt|html|[cm]?[jt]sx?)$/.test(name) && !/\.(?:test|spec)\./.test(name));
  const texts = [];

  for (const dir of options.dirs || []) {
    for (const filePath of walkFiles(resolveProjectPath(rootDir, dir), {
      skippedDirs: options.skippedDirs ? new Set(options.skippedDirs) : DEFAULT_SKIPPED_DIRS,
      include
    })) {
      texts.push({ name: path.relative(rootDir, filePath), text: fs.readFileSync(filePath, 'utf8') });
    }
  }

  return { fileCount: texts.length, ...findForbiddenTerms(texts, options.terms, options) };
}

function formatTermReport(report) {
  return [
    ...report.findings.map((entry) => `${entry.source}:${entry.line} "${entry.match}" (${entry.term})${entry.reason ? ` — ${entry.reason}` : ''}: ${entry.excerpt}`),
    ...report.missing.map((entry) => `${entry.source}: must contain ${entry.term}`)
  ].join('\n');
}

/** Throws with every forbidden occurrence and every missing required term. */
function assertNoForbiddenTerms(texts, terms, options = {}) {
  const report = findForbiddenTerms(texts, terms, options);
  if (!report.ok) {
    throw new Error(`Forbidden terms found:\n${formatTermReport(report)}`);
  }
  return report;
}

module.exports = {
  assertNoForbiddenTerms,
  findForbiddenTerms,
  findForbiddenTermsInFiles,
  formatTermReport
};
