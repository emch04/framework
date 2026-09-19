/**
 * "This role sees, it does not write" — proven by reading the source.
 *
 * The defect this exists for: a support or auditor role is granted read access
 * everywhere, then one day it is copy-pasted into the role list of a POST route
 * next to the GET it was meant for. Nothing fails. The role now edits customer
 * data, and the proof of that edit carries a vendor's name. A behaviour test
 * only covers the routes someone thought of; this audit covers every write
 * declaration in the tree, including the one added next quarter.
 *
 * It is a heuristic over text, not a type system. It follows role lists
 * declared in the SAME file (`authorizeRoles(...WRITERS)`, `const WRITERS =
 * STAFF.filter(...)`), and treats `x !== ROLE` / `list.filter(r => r !== ROLE)`
 * / `except(list, ROLE)` as exclusions. Lists imported from another file are
 * not followed — declare them where the route is, or audit that file too.
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_SKIPPED_DIRS, lineNumberAt, resolveProjectPath, walkFiles } = require('../fsUtils');
const { escapeRegExp, findClosing, findExpressionEnd, stripComments } = require('./sourceScan');

/* Express-style write declarations: `router.post(`, `app.delete(`,
   `adminRouter.patch(`, and the chained `.route('/x').put(` form. Group 1 is
   the HTTP method. */
const DEFAULT_WRITE_CALLS = [
  /\b(?:app|(?:[A-Za-z_$][\w$]*)?[Rr]outer)\s*\.\s*(post|put|patch|delete)\s*\(/g,
  /\)\s*\.\s*(post|put|patch|delete)\s*\(/g
];

/* Names of role lists that grant writing. Matched against the declared
   identifier: `writers`, `WRITE_ROLES`, `EDITORS`, `canApprove`... */
/* `manage` is left out on purpose: MANAGERS is as often the read list of an
   admin screen as a write list, and a name that cries wolf gets ignored. */
const DEFAULT_AUTHOR_LIST_NAMES = /writ|author|editor|decid|approv|publish/i;
const FUNCTION_EXPRESSION = /^\s*(?:async\b|function\b|[A-Za-z_$][\w$]*\s*=>|\([^()]*\)\s*=>)/;

const ARRAY_METHODS = new Set(['filter', 'concat', 'slice', 'map', 'flat', 'flatMap', 'toSpliced', 'with']);
const DEFAULT_INCLUDE = (name) => /\.(?:c|m)?[jt]sx?$/.test(name) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) && !name.endsWith('.d.ts');

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * One regex source matching any spelling of the role (`ROLES.SUPPORT`,
 * `'support'`...). Identifier characters on either side do not count as a
 * match: `SUPPORT_LEAD` is another role.
 */
function roleSource(role) {
  const spellings = toArray(role).map((entry) => {
    if (entry instanceof RegExp) return entry.source;
    if (typeof entry === 'string' && entry.trim()) return escapeRegExp(entry.trim());
    throw new Error('auditRoleWrites: every role spelling must be a non-empty string or a RegExp.');
  });
  if (!spellings.length) {
    throw new Error('auditRoleWrites requires options.role.');
  }
  return `(?<![\\w$])(?:${spellings.join('|')})(?![\\w$])`;
}

/**
 * The expressions that REMOVE the role from a list. They are blanked out before
 * the role is looked for, so `STAFF.filter((r) => r !== ROLE)` is read as a
 * list without the role — and STAFF is not followed, because its content no
 * longer reaches this route.
 */
function buildExclusions(role, extra) {
  return [
    new RegExp(`[A-Za-z_$][\\w$.]*\\s*\\.\\s*filter\\s*\\(\\s*\\(?\\s*([A-Za-z_$][\\w$]*)\\s*\\)?\\s*=>\\s*\\1\\s*!==?\\s*${role}\\s*\\)`, 'g'),
    new RegExp(`\\bexcept\\s*\\([^()]*${role}[^()]*\\)`, 'g'),
    new RegExp(`!==?\\s*${role}`, 'g'),
    new RegExp(`${role}\\s*!==?`, 'g'),
    ...toArray(extra).map((pattern) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))
  ];
}

function collectDeclarations(source) {
  const declarations = new Map();
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let match;

  while ((match = pattern.exec(source))) {
    const start = match.index + match[0].length;
    const end = findExpressionEnd(source, start);
    declarations.set(match[1], { name: match[1], index: match.index, expression: source.slice(start, end) });
  }

  return declarations;
}

/** Identifiers an expression refers to, minus property names and object members. */
function referencedIdentifiers(expression) {
  const names = [];
  const pattern = /[A-Za-z_$][\w$]*/g;
  let match;

  while ((match = pattern.exec(expression))) {
    const before = expression.slice(0, match.index);
    /* A property name (`obj.NAME`) is not a reference; a spread (`...NAME`) is. */
    if (/(?:^|[^.])\.\s*$/.test(before)) continue;
    const after = expression.slice(match.index + match[0].length);
    const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(after);
    /* `ROLES.ADMIN` names one role, not the whole ROLES object; only array
       methods (`STAFF.concat(...)`) carry the list's content forward. */
    if (member && !ARRAY_METHODS.has(member[1])) continue;
    names.push(match[0]);
  }

  return names;
}

/**
 * Does the role reach this expression, directly or through a same-file list?
 * Returns the chain of identifiers it came through, or null.
 */
function reach(expression, context, seen) {
  let text = stripComments(expression);
  for (const exclusion of context.exclusions) {
    exclusion.lastIndex = 0;
    text = text.replace(exclusion, ' ');
  }

  if (new RegExp(context.role).test(text)) {
    return [];
  }

  for (const name of referencedIdentifiers(text)) {
    const declaration = context.declarations.get(name);
    /* A handler is not a role list. Its body checks roles in every direction
       (`if (role === X) return 403`), so following it would flag the route
       that REFUSES the role as one that grants it. */
    if (!declaration || seen.has(name) || FUNCTION_EXPRESSION.test(declaration.expression)) continue;
    seen.add(name);
    const via = reach(declaration.expression, context, seen);
    if (via) return [name, ...via];
  }

  return null;
}

function firstStringLiteral(text) {
  const match = /["'`]([^"'`]*)["'`]/.exec(text);
  return match ? match[1] : null;
}

/** The path of `router.route('/x').post(...)`, read back from the chain. */
function chainedRoute(source, index) {
  const match = /\.\s*route\s*\(\s*["'`]([^"'`]*)["'`]\s*\)$/.exec(source.slice(Math.max(0, index - 300), index + 1));
  return match ? match[1] : null;
}

function auditRoleWriteSource(source, options) {
  const role = roleSource(options.role);
  const context = {
    role,
    exclusions: buildExclusions(role, options.exclusions),
    declarations: collectDeclarations(source)
  };
  const findings = [];
  const seenCalls = new Set();

  for (const writeCall of toArray(options.writeCalls || DEFAULT_WRITE_CALLS)) {
    const pattern = new RegExp(writeCall.source, writeCall.flags.includes('g') ? writeCall.flags : `${writeCall.flags}g`);
    let match;

    while ((match = pattern.exec(source))) {
      const openIndex = match.index + match[0].length - 1;
      if (seenCalls.has(openIndex) || source[openIndex] !== '(') continue;
      seenCalls.add(openIndex);

      const closeIndex = findClosing(source, openIndex);
      const args = source.slice(openIndex + 1, closeIndex);
      const via = reach(args, context, new Set());
      if (!via) continue;

      findings.push({
        kind: 'route',
        line: lineNumberAt(source, match.index),
        method: (match[1] || '?').toUpperCase(),
        route: firstStringLiteral(args) ?? chainedRoute(source, match.index),
        via,
        code: source.slice(match.index, closeIndex + 1)
      });
    }
  }

  const listNames = options.authorListNames === undefined ? DEFAULT_AUTHOR_LIST_NAMES : options.authorListNames;
  if (listNames) {
    for (const declaration of context.declarations.values()) {
      if (!listNames.test(declaration.name)) continue;
      const via = reach(declaration.expression, context, new Set([declaration.name]));
      if (!via) continue;

      findings.push({
        kind: 'list',
        line: lineNumberAt(source, declaration.index),
        name: declaration.name,
        via,
        code: source.slice(declaration.index, declaration.index + declaration.expression.length + 40).split('\n')[0]
      });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

function validateExceptions(exceptions) {
  return toArray(exceptions).map((exception, index) => {
    if (!exception || (typeof exception.match !== 'string' && !(exception.match instanceof RegExp))) {
      throw new Error(`auditRoleWrites: exceptions[${index}].match must be a string or a RegExp.`);
    }
    /* An exception without a reason is a hole nobody can review. The reason
       is what lets the next person decide whether it still holds. */
    if (typeof exception.reason !== 'string' || !exception.reason.trim()) {
      throw new Error(`auditRoleWrites: exceptions[${index}] (${exception.match}) needs a written reason.`);
    }
    return exception;
  });
}

function exceptionApplies(exception, finding) {
  if (exception.file && !finding.file.includes(exception.file)) return false;
  return typeof exception.match === 'string'
    ? finding.code.includes(exception.match)
    : new RegExp(exception.match.source, exception.match.flags.replace('g', '')).test(finding.code);
}

/**
 * @param {object} options
 * @param {string|RegExp|Array<string|RegExp>} options.role every spelling of the role in source.
 * @param {string[]} options.dirs source directories, relative to rootDir.
 * @param {string} [options.rootDir]
 * @param {Array<{match: string|RegExp, reason: string, file?: string}>} [options.exceptions]
 * @param {RegExp[]} [options.writeCalls] write declarations, group 1 = HTTP method.
 * @param {RegExp|false} [options.authorListNames] names of writer role lists.
 * @param {RegExp[]} [options.exclusions] extra patterns that remove the role.
 */
function auditRoleWrites(options = {}) {
  const exceptions = validateExceptions(options.exceptions);
  roleSource(options.role);
  const rootDir = options.rootDir || process.cwd();
  const dirs = toArray(options.dirs);
  if (!dirs.length) {
    throw new Error('auditRoleWrites requires options.dirs.');
  }

  const include = options.include || DEFAULT_INCLUDE;
  const findings = [];
  const exempted = [];
  const used = new Set();
  let fileCount = 0;

  for (const dir of dirs) {
    for (const filePath of walkFiles(resolveProjectPath(rootDir, dir), {
      skippedDirs: options.skippedDirs ? new Set(options.skippedDirs) : DEFAULT_SKIPPED_DIRS,
      include
    })) {
      fileCount++;
      const file = path.relative(rootDir, filePath);

      for (const raw of auditRoleWriteSource(fs.readFileSync(filePath, 'utf8'), options)) {
        const finding = { file, ...raw };
        const exception = exceptions.find((candidate) => exceptionApplies(candidate, finding));
        if (exception) {
          used.add(exception);
          exempted.push({ ...finding, reason: exception.reason });
        } else {
          findings.push(finding);
        }
      }
    }
  }

  return {
    fileCount,
    findings,
    exempted,
    /* An exception that matches nothing is stale: the route was renamed or
       removed, and the entry now waits to silently excuse whatever takes its
       name next. It is reported so it gets deleted. */
    unusedExceptions: exceptions.filter((exception) => !used.has(exception))
  };
}

function formatRoleWriteFindings(result) {
  const lines = result.findings.map((finding) => {
    const where = finding.kind === 'route' ? `${finding.method} ${finding.route ?? '?'}` : `list ${finding.name}`;
    const via = finding.via.length ? ` (via ${finding.via.join(' -> ')})` : '';
    return `${finding.file}:${finding.line} ${where}${via}`;
  });
  for (const exception of result.unusedExceptions) {
    lines.push(`unused exception ${exception.match}: ${exception.reason}`);
  }
  return lines.join('\n');
}

/** Throws with every write the role still reaches, and every stale exception. */
function assertRoleReadOnly(options) {
  const result = auditRoleWrites(options);
  if (result.findings.length || result.unusedExceptions.length) {
    throw new Error(`Role can still write:\n${formatRoleWriteFindings(result)}`);
  }
  return result;
}

module.exports = {
  DEFAULT_WRITE_CALLS,
  assertRoleReadOnly,
  auditRoleWriteSource,
  auditRoleWrites,
  formatRoleWriteFindings
};
