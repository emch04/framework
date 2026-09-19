/**
 * A small, string-aware scanner for JavaScript source.
 *
 * The guards read route and controller files as TEXT, on purpose: a test that
 * reads the file catches the line someone adds six months from now, which no
 * controller test would. Text scanning has one classic trap — a bracket inside
 * a string or a comment closes the wrong call — so every walk below skips
 * literals and comments instead of counting characters blindly.
 */

const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/**
 * If `index` starts a string, template or comment, returns the index just past
 * it; otherwise -1. Template `${}` holes are skipped whole: a role mentioned in
 * an interpolated message is still inside a string, not an authorisation.
 */
function skipLiteral(source, index) {
  const char = source[index];
  const next = source[index + 1];

  if (char === '/' && next === '/') {
    const end = source.indexOf('\n', index);
    return end === -1 ? source.length : end;
  }

  if (char === '/' && next === '*') {
    const end = source.indexOf('*/', index + 2);
    return end === -1 ? source.length : end + 2;
  }

  if (char === '"' || char === "'" || char === '`') {
    let i = index + 1;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === char) {
        return i + 1;
      }
      i++;
    }
    return source.length;
  }

  return -1;
}

/** Index of the bracket closing the one at `openIndex` (or source end). */
function findClosing(source, openIndex) {
  let depth = 0;
  let i = openIndex;

  while (i < source.length) {
    const skipped = skipLiteral(source, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    const char = source[i];
    if (OPENERS[char]) {
      depth++;
    } else if (CLOSERS.has(char)) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }

  return source.length - 1;
}

/**
 * End of the expression starting at `start`: the first `;`, or the first line
 * break at bracket depth 0 that is not followed by a chained `.call()`.
 */
function findExpressionEnd(source, start) {
  let depth = 0;
  let i = start;

  while (i < source.length) {
    const skipped = skipLiteral(source, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    const char = source[i];
    if (OPENERS[char]) {
      depth++;
    } else if (CLOSERS.has(char)) {
      if (depth === 0) {
        return i;
      }
      depth--;
    } else if (depth === 0 && (char === ';' || char === ',')) {
      return i;
    } else if (depth === 0 && char === '\n' && !/^\s*[.?]/.test(source.slice(i + 1, i + 40))) {
      return i;
    }
    i++;
  }

  return source.length;
}

/** The source with every comment replaced by spaces (offsets preserved). */
function stripComments(source) {
  let output = '';
  let i = 0;

  while (i < source.length) {
    const skipped = skipLiteral(source, i);
    if (skipped === -1) {
      output += source[i];
      i++;
      continue;
    }

    const chunk = source.slice(i, skipped);
    output += chunk.startsWith('//') || chunk.startsWith('/*') ? chunk.replace(/[^\n]/g, ' ') : chunk;
    i = skipped;
  }

  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  escapeRegExp,
  findClosing,
  findExpressionEnd,
  skipLiteral,
  stripComments
};
