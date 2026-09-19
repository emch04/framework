/**
 * Reading JavaScript SOURCE for mistakes the running code cannot see.
 *
 * Two of them, both found in a real catalogue:
 *
 *   A key written twice in an object literal. JavaScript keeps the LAST value
 *   and says nothing — no warning, no lint error by default in a data file.
 *   A sentence had two translations in one language, the first one reviewed
 *   and correct, the second one older and wrong; only the wrong one was ever
 *   served. `Object.keys()` cannot catch it: by the time the object exists,
 *   the first value is gone. Only the source still shows both.
 *
 *   A mail subject written in the call. A translated body wrapped around a
 *   subject typed in the source language reads like a bug to the recipient,
 *   and the subject is the one line everybody sees. The rule is simple —
 *   subjects come from the catalogue — and a scan keeps it from eroding.
 *
 * This is not a parser. It masks comments and string contents so braces,
 * commas and parentheses inside them are not mistaken for structure, then
 * walks the rest. Regular-expression literals are not recognised: a `{` in a
 * regex inside the scanned object would shift the depth. Catalogue files do
 * not contain those in practice; if yours does, scan a smaller `start`.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', 'coverage'];

/**
 * Same length as the source, line breaks kept: comments become spaces, string
 * and template contents become spaces between their quotes. `${…}` inside a
 * template stays code, because it is.
 */
function maskSource(source) {
  const out = source.split('');
  const blank = (index) => { if (out[index] !== '\n') out[index] = ' '; };
  const n = source.length;
  const templateDepths = [];
  let depth = 0;
  let inTemplate = false;
  let i = 0;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (inTemplate) {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '`') { inTemplate = false; i += 1; continue; }
      if (c === '$' && next === '{') {
        blank(i); blank(i + 1);
        templateDepths.push(depth);
        depth += 1;
        inTemplate = false;
        i += 2;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }

    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { blank(i); i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { blank(i); i += 1; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') { blank(i); i += 1; }
        blank(i);
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '`') { inTemplate = true; i += 1; continue; }
    if (c === '{') depth += 1;
    if (c === '}') {
      if (templateDepths.length && templateDepths[templateDepths.length - 1] === depth - 1) {
        /* The end of a `${…}`: back inside the template it interrupted. */
        templateDepths.pop();
        depth -= 1;
        blank(i);
        inTemplate = true;
        i += 1;
        continue;
      }
      depth -= 1;
    }
    i += 1;
  }

  return out.join('');
}

const lineAt = (source, index) => source.slice(0, index).split('\n').length;
const OPEN = '([{';
const CLOSE = ')]}';
const IDENTIFIER = /[\w$]/;

/**
 * The entries of the object literal whose `{` is at `openIndex`.
 * Only direct entries — nested objects are skipped over, not listed.
 */
function entriesOf(masked, source, openIndex) {
  const entries = [];
  const n = masked.length;
  let depth = 1;
  let i = openIndex + 1;
  let atEntryStart = true;
  let current = null;

  const closeCurrent = (end) => {
    if (current) {
      current.valueEnd = end;
      entries.push(current);
      current = null;
    }
  };

  while (i < n && depth > 0) {
    if (atEntryStart) {
      while (i < n && /\s/.test(masked[i])) i += 1;
      atEntryStart = false;
      const c = masked[i];
      let key = null;
      let keyStart = i;
      let j = i;

      if (c === '"' || c === "'") {
        const end = masked.indexOf(c, i + 1);
        if (end !== -1) {
          key = source.slice(i + 1, end).replace(/\\(.)/g, '$1');
          j = end + 1;
        }
      } else if (c && IDENTIFIER.test(c)) {
        while (j < n && IDENTIFIER.test(masked[j])) j += 1;
        key = masked.slice(i, j);
      }

      if (key !== null) {
        let k = j;
        while (k < n && /\s/.test(masked[k])) k += 1;
        if (masked[k] === ':') {
          current = { key, line: lineAt(source, keyStart), valueStart: k + 1, valueEnd: null };
          i = k + 1;
          continue;
        }
      }
      continue;
    }

    const c = masked[i];
    if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) {
      depth -= 1;
      if (depth === 0) { closeCurrent(i); break; }
    } else if (c === ',' && depth === 1) {
      closeCurrent(i);
      atEntryStart = true;
    }
    i += 1;
  }

  closeCurrent(i);
  return entries;
}

/** Where to start: the first `{` after `start` (a string or a RegExp), in code only. */
function findOpening(masked, start) {
  let from = 0;
  if (typeof start === 'string') {
    from = masked.indexOf(start);
    if (from === -1) return -1;
  } else if (start instanceof RegExp) {
    const match = new RegExp(start.source, start.flags.replace('g', '')).exec(masked);
    if (!match) return -1;
    from = match.index;
  }
  return masked.indexOf('{', from);
}

/**
 * Keys written more than once in one object literal.
 *
 * @param {string} source the file's text — read it yourself, so this works on
 *   any file, generated or not.
 * @param {object} [options]
 * @param {string|RegExp} [options.start] where the object begins, e.g.
 *   'const MESSAGES = {'. Default: the first `{` of the file.
 * @returns {{keys: Array<{key: string, line: number}>, duplicates: Array<{key: string, lines: number[]}>}}
 *   `keys` is every key in source order. Compare its length with
 *   `Object.keys(loaded).length` to prove the scan read the whole object.
 */
function findDuplicateKeys(source, options = {}) {
  const text = String(source || '');
  const masked = maskSource(text);
  const open = findOpening(masked, options.start);
  if (open === -1) {
    throw new Error(`findDuplicateKeys: no object literal found${options.start ? ` after ${options.start}` : ''}.`);
  }

  const keys = entriesOf(masked, text, open).map(({ key, line }) => ({ key, line }));
  const seen = new Map();
  for (const { key, line } of keys) {
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(line);
  }
  const duplicates = [...seen].filter(([, lines]) => lines.length > 1).map(([key, lines]) => ({ key, lines }));
  return { keys, duplicates };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split a call's arguments: [{start, end}] for each, in masked coordinates. */
function argumentsOf(masked, openParen) {
  const args = [];
  let depth = 0;
  let start = openParen + 1;
  for (let i = openParen + 1; i < masked.length; i += 1) {
    const c = masked[i];
    if (OPEN.includes(c)) depth += 1;
    else if (CLOSE.includes(c)) {
      if (depth === 0) {
        if (masked.slice(start, i).trim()) args.push({ start, end: i });
        return { args, end: i };
      }
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      args.push({ start, end: i });
      start = i + 1;
    }
  }
  return { args, end: masked.length };
}

/** A string or template literal starting the range, or null. */
function literalAt(masked, source, start, end) {
  let i = start;
  while (i < end && /\s/.test(masked[i])) i += 1;
  const quote = masked[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  const close = masked.indexOf(quote, i + 1);
  if (close === -1 || close >= end) return null;
  /* Only a literal that IS the whole value counts: `"Re: " + subject` is
     already built from something else. */
  if (masked.slice(close + 1, end).trim()) return null;
  return { raw: source.slice(i, close + 1), index: i };
}

/**
 * Subjects written in the source instead of coming from the catalogue.
 *
 * @param {string} source
 * @param {object} options
 * @param {string} options.callee the send function as written: 'sendEmail',
 *   'mailer.send'.
 * @param {number} [options.argument] which argument holds the subject (or the
 *   message object). Default 0.
 * @param {string} [options.property] when that argument is an object literal,
 *   the property holding the subject — `mailer.send({ subject: "…" })`.
 * @param {RegExp|Function} [options.test] what makes a literal "written text".
 *   Default: any letter. Narrow it to one language's words if your code
 *   legitimately carries internal subjects in another.
 * @param {RegExp[]} [options.ignore] a call whose full text matches one of
 *   these is skipped — an internal alert to a fixed team address, for example.
 * @returns {Array<{line: number, callee: string, literal: string}>}
 */
function findHardcodedSubjects(source, options = {}) {
  const callee = options.callee;
  if (!callee || typeof callee !== 'string') {
    throw new Error('findHardcodedSubjects requires options.callee, e.g. "sendEmail".');
  }
  const argument = options.argument === undefined ? 0 : options.argument;
  const property = options.property;
  const ignore = options.ignore || [];
  const test = options.test || /\p{L}/u;
  const looksWritten = typeof test === 'function'
    ? test
    : (text) => new RegExp(test.source, test.flags.replace('g', '')).test(text);

  const text = String(source || '');
  const masked = maskSource(text);
  const calls = new RegExp(`(?<![\\w$])${escapeRegExp(callee)}\\s*\\(`, 'g');
  const findings = [];

  let match;
  while ((match = calls.exec(masked))) {
    const openParen = match.index + match[0].length - 1;
    const { args, end } = argumentsOf(masked, openParen);
    if (ignore.some((pattern) => pattern.test(text.slice(match.index, end + 1)))) continue;

    const target = args[argument];
    if (!target) continue;

    let range = target;
    if (property) {
      const brace = masked.slice(target.start, target.end).search(/\S/);
      const open = target.start + brace;
      if (brace === -1 || masked[open] !== '{') continue;
      const entry = entriesOf(masked, text, open).find((candidate) => candidate.key === property);
      if (!entry) continue;
      range = { start: entry.valueStart, end: entry.valueEnd };
    }

    const literal = literalAt(masked, text, range.start, range.end);
    if (!literal) continue;
    /* Placeholders are not written text: `${name}` alone is a variable. */
    const written = literal.raw.slice(1, -1).replace(/\$\{[^}]*\}/g, '');
    if (!looksWritten(written)) continue;

    findings.push({ line: lineAt(text, literal.index), callee, literal: literal.raw.slice(0, 80) });
  }

  return findings;
}

/**
 * Walk a source tree and run `inspect` on every file.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {Function} options.inspect (source, file) => finding[] — `file` is
 *   relative to root, and added to each finding.
 * @param {string[]} [options.extensions] default ['.js']
 * @param {string[]} [options.ignore] directory or file names to skip.
 */
function scanSourceTree(options = {}) {
  const root = options.root;
  if (!root) throw new Error('scanSourceTree requires options.root.');
  if (typeof options.inspect !== 'function') throw new Error('scanSourceTree requires options.inspect.');

  const extensions = options.extensions || ['.js'];
  const ignore = new Set(options.ignore || DEFAULT_IGNORE);
  const findings = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignore.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      const file = path.relative(root, full);
      if (ignore.has(file)) continue;
      for (const finding of options.inspect(fs.readFileSync(full, 'utf8'), file) || []) {
        findings.push({ file, ...finding });
      }
    }
  };

  walk(root);
  return findings;
}

module.exports = { findDuplicateKeys, findHardcodedSubjects, scanSourceTree };
