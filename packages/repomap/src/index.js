'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ignore = require('ignore');

const DEFAULT_LANGUAGE_EXTENSIONS = Object.freeze({
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  typescript: ['.ts'],
  tsx: ['.tsx'],
  python: ['.py'],
});
const GRAMMARS = Object.freeze({
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
});
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const DECLARATION_TYPES = new Set([
  'function_declaration', 'function_definition', 'class_declaration', 'class_definition',
  'interface_declaration', 'type_alias_declaration', 'enum_declaration',
]);

function tokenizeDefault(text) {
  return text.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu)?.length ?? 0;
}

function walkTree(root) {
  const files = [];
  const visit = async (directory, relative = '') => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) await visit(path.join(directory, entry.name), rel);
      } else if (entry.isFile()) files.push({ absolute: path.join(directory, entry.name), relative: rel });
    }
  };
  return visit(root).then(() => files);
}

function makeGrammarResolver(wasmDirectory) {
  if (wasmDirectory) return name => path.join(wasmDirectory, name);
  let packageRoot;
  try { packageRoot = path.dirname(require.resolve('tree-sitter-wasms/package.json')); }
  catch { packageRoot = path.dirname(require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm')); }
  return name => path.join(packageRoot, 'out', name);
}

async function createParser(language, resolver, parserCache) {
  if (parserCache.has(language)) return parserCache.get(language);
  let promise = (async () => {
    const { Parser, Language } = await import('web-tree-sitter');
    await Parser.init();
    const parser = new Parser();
    const wasm = await Language.load(resolver(GRAMMARS[language]));
    parser.setLanguage(wasm);
    return parser;
  })();
  parserCache.set(language, promise);
  return promise;
}

function collectSymbols(tree) {
  const definitions = [];
  const references = [];
  const imports = [];
  const addDefinition = (symbol, node) => {
    if (symbol && IDENTIFIER.test(symbol)) definitions.push({ symbol, row: node.startPosition.row });
  };
  const memberName = node => node?.childForFieldName?.('property')?.text ?? node?.namedChildren?.at(-1)?.text;
  const parent = ancestors => ancestors.at(-1);
  const topLevel = ancestors => {
    let current = parent(ancestors);
    if (current?.type === 'export_statement' || current?.type === 'expression_statement') current = parent(ancestors.slice(0, -1));
    return ['program', 'module', 'source_file'].includes(current?.type);
  };
  const visit = (node, ancestors = []) => {
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const source = node.childForFieldName?.('source');
      if (source) imports.push(source.text.slice(1, -1));
    }
    if (node.type === 'call_expression' && node.childForFieldName?.('function')?.text === 'require') {
      const argument = node.childForFieldName?.('arguments')?.namedChildren?.[0];
      if (argument?.type === 'string' && !ancestors.some(item => ['function_declaration', 'function_definition', 'arrow_function', 'function_expression', 'method_definition'].includes(item.type))) imports.push(argument.text.slice(1, -1));
    }
    if (node.type === 'identifier' || node.type === 'property_identifier' || node.type === 'type_identifier') {
      if (IDENTIFIER.test(node.text)) references.push(node.text);
    }
    if (DECLARATION_TYPES.has(node.type) && (topLevel(ancestors) || (node.type === 'function_definition' && parent(ancestors)?.type === 'block' && ancestors.some(item => item.type === 'class_definition')))) addDefinition(node.childForFieldName?.('name')?.text, node);
    if (node.type === 'method_definition' && parent(ancestors)?.type === 'class_body') addDefinition(node.childForFieldName?.('name')?.text, node);
    if ((node.type === 'lexical_declaration' || node.type === 'variable_declaration') && topLevel(ancestors)) {
      for (const declarator of node.namedChildren ?? []) {
        if (declarator.type !== 'variable_declarator') continue;
        const value = declarator.childForFieldName?.('value');
        if (value && (['arrow_function', 'function_expression', 'function', 'class'].includes(value.type) || (value.type === 'call_expression' && /(^|\.)model$/.test(value.childForFieldName?.('function')?.text ?? '')))) {
          addDefinition(declarator.childForFieldName?.('name')?.text, declarator);
        }
      }
    }
    if (node.type === 'assignment_expression' && topLevel(ancestors)) {
      const left = node.childForFieldName?.('left');
      const right = node.childForFieldName?.('right');
      if (left?.type === 'member_expression' && left.childForFieldName?.('object')?.text === 'exports') {
        addDefinition(memberName(left), node);
      } else if (left?.type === 'member_expression' && left.childForFieldName?.('object')?.text === 'module' && memberName(left) === 'exports' && right?.type === 'object') {
        for (const pair of right.namedChildren ?? []) if (pair.type === 'pair') addDefinition(pair.childForFieldName?.('key')?.text, pair);
      }
    }
    for (const child of node.namedChildren ?? []) visit(child, [...ancestors, node]);
  };
  visit(tree.rootNode);
  const unique = new Map();
  for (const definition of definitions) unique.set(`${definition.symbol}:${definition.row}`, definition);
  return { definitions: [...unique.values()], references, imports };
}

function resolveImport(from, request, files) {
  if (!request.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), request));
  for (const candidate of [base, `${base}.js`, `${base}/index.js`]) if (files.has(candidate)) return candidate;
  return null;
}

function pagerank(files, edges, options = {}) {
  const damping = 0.85;
  const iterations = 30;
  const ids = files.map(file => file.path);
  const conversation = new Set(options.conversationFiles ?? []);
  const directImports = new Set(edges.filter(edge => edge.kind === 'import' && conversation.has(edge.from)).map(edge => edge.to));
  const teleportWeights = new Map(ids.map(id => [id, conversation.has(id) ? 50 : directImports.has(id) ? 20 : 1]));
  const teleportTotal = [...teleportWeights.values()].reduce((sum, value) => sum + value, 0) || 1;
  const base = new Map(ids.map(id => [id, teleportWeights.get(id) / teleportTotal]));
  let rank = new Map(base);
  for (let step = 0; step < iterations; step++) {
    const next = new Map(ids.map(id => [id, (1 - damping) * base.get(id)]));
    let dangling = 0;
    for (const from of ids) {
      const outgoing = edges.filter(edge => edge.from === from && edge.to !== from);
      const total = outgoing.reduce((sum, edge) => sum + edge.weight, 0);
      if (!total) dangling += rank.get(from);
      else for (const edge of outgoing) next.set(edge.to, next.get(edge.to) + damping * rank.get(from) * edge.weight / total);
    }
    for (const id of ids) next.set(id, next.get(id) + damping * dangling * base.get(id));
    rank = next;
  }
  return rank;
}

function weightedReferenceCount(references, targetDefinitions, options) {
  const mentions = new Set(options.mentionedIdentifiers ?? []);
  let count = 0;
  for (const identifier of references) {
    if (!targetDefinitions.has(identifier)) continue;
    let weight = 1;
    if (identifier.length > 6) weight *= 10;
    if (identifier.startsWith('_')) weight *= 0.1;
    if (mentions.has(identifier)) weight *= 10;
    count += weight;
  }
  return count;
}

function render(files, budget, counter) {
  const rows = [];
  for (const file of files) {
    if (!file.definitions.length) rows.push({ path: file.path, header: true });
    else {
      rows.push({ path: file.path, header: true });
      for (const definition of file.definitions) rows.push({ path: file.path, definition });
    }
  }
  let low = 0;
  let high = rows.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const out = [];
    let remaining = mid;
    for (const file of files) {
      if (remaining < 1) break;
      if (out.length) out.push('');
      out.push(file.path);
      remaining -= 1;
      const included = Math.min(file.definitions.length, remaining);
      for (const definition of file.definitions.slice(0, included)) out.push(`  │ ${definition.text.slice(0, 120)}`);
      remaining -= included;
      if (included < file.definitions.length && remaining === 0) out.push('  ⋮');
      if (included < file.definitions.length) break;
    }
    const candidate = out.join('\n');
    if (counter(candidate) <= budget) { best = candidate; low = mid + 1; }
    else high = mid - 1;
  }
  if (!best && budget > 0) {
    for (const file of files) for (const definition of file.definitions) {
      const candidate = `${file.path}\n  │ ${definition.text.slice(0, 120)}`;
      if (counter(candidate) <= budget) return candidate;
    }
  }
  return best;
}

/** Construit une carte de symboles pondérée pour un dépôt. */
async function buildRepoMap(rootDirectory, options = {}) {
  const root = path.resolve(rootDirectory);
  const budget = Number.isFinite(options.budget) ? Math.max(0, options.budget) : 1024;
  const counter = options.tokenCounter ?? tokenizeDefault;
  const languages = options.languages ?? Object.keys(DEFAULT_LANGUAGE_EXTENSIONS);
  const extensions = new Set(languages.flatMap(language => DEFAULT_LANGUAGE_EXTENSIONS[language] ?? []));
  const parserCache = options.parserCache ?? new Map();
  const cache = options.cache ?? new Map();
  const resolver = makeGrammarResolver(options.wasmDirectory);
  const ig = ignore();
  try { ig.add(await fs.readFile(path.join(root, '.gitignore'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = [];
  for (const item of await walkTree(root)) {
    if (!extensions.has(path.extname(item.relative)) || ig.ignores(item.relative)) continue;
    let bytes;
    try { bytes = await fs.readFile(item.absolute); } catch { continue; }
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8');
    const fingerprint = `${(await fs.stat(item.absolute)).mtimeMs}:${bytes.length}:${crypto.createHash('sha1').update(bytes).digest('hex')}`;
    let analysis = cache.get(item.relative);
    if (!analysis || analysis.fingerprint !== fingerprint) {
      const language = Object.keys(DEFAULT_LANGUAGE_EXTENSIONS).find(key => DEFAULT_LANGUAGE_EXTENSIONS[key].includes(path.extname(item.relative)));
      const parser = await createParser(language, resolver, parserCache);
      const tree = parser.parse(source);
      const symbols = collectSymbols(tree);
      const definitions = [];
      const lines = source.split(/\r?\n/);
      for (const { symbol, row } of symbols.definitions) definitions.push({ symbol, line: row + 1, text: lines[row]?.trim() ?? '' });
      analysis = { fingerprint, definitions, lines: definitions.map(definition => definition.line), references: symbols.references, imports: symbols.imports, source };
      cache.set(item.relative, analysis);
    }
    files.push({ path: item.relative, ...analysis });
  }
  const definitionsByFile = new Map(files.map(file => [file.path, new Set(file.definitions.map(item => item.symbol))]));
  const definitionsBySymbol = new Map();
  for (const file of files) for (const definition of file.definitions) {
    if (!definitionsBySymbol.has(definition.symbol)) definitionsBySymbol.set(definition.symbol, new Set());
    definitionsBySymbol.get(definition.symbol).add(file.path);
  }
  const edges = [];
  const availableFiles = new Set(files.map(file => file.path));
  for (const file of files) {
    for (const request of file.imports ?? []) {
      const target = resolveImport(file.path, request, availableFiles);
      if (target) edges.push({ from: file.path, to: target, weight: 30, kind: 'import' });
    }
    const referencesByTarget = new Map();
    for (const reference of file.references) for (const target of definitionsBySymbol.get(reference) ?? []) {
      if (target !== file.path) referencesByTarget.set(target, (referencesByTarget.get(target) ?? 0) + 1);
    }
    for (const [target, rawCount] of referencesByTarget) {
      const targetSymbols = definitionsByFile.get(target);
      const weighted = weightedReferenceCount(file.references, targetSymbols, options);
      edges.push({ from: file.path, to: target, weight: Math.sqrt(weighted || rawCount), kind: 'reference' });
    }
  }
  const ranks = pagerank(files, edges, options);
  const rankScale = ranks;
  const conversationFiles = new Set(options.conversationFiles ?? []);
  const directConversationImports = new Set(edges.filter(edge => edge.kind === 'import' && conversationFiles.has(edge.from)).map(edge => edge.to));
  const conversationImports = new Set(directConversationImports);
  const mentioned = new Set(options.mentionedIdentifiers ?? []);
  const definitionFrequency = new Map();
  for (const file of files) for (const reference of file.references) definitionFrequency.set(reference, (definitionFrequency.get(reference) ?? 0) + 1);
  const ranked = files.map(file => {
    const definitions = [...file.definitions].sort((a, b) =>
      Number(mentioned.has(b.symbol)) - Number(mentioned.has(a.symbol)) ||
      (definitionFrequency.get(b.symbol) ?? 0) - (definitionFrequency.get(a.symbol) ?? 0) || a.line - b.line);
    return { path: file.path, rank: rankScale.get(file.path), definitions, lines: definitions.map(definition => definition.line) };
  })
    .sort((a, b) => Number(conversationFiles.has(b.path)) - Number(conversationFiles.has(a.path)) ||
      Number(b.definitions.some(definition => mentioned.has(definition.symbol))) - Number(a.definitions.some(definition => mentioned.has(definition.symbol))) ||
      Number(directConversationImports.has(b.path)) - Number(directConversationImports.has(a.path)) ||
      (directConversationImports.has(a.path) && directConversationImports.has(b.path) ? Number(b.path.endsWith('.model.js')) - Number(a.path.endsWith('.model.js')) || (a.path.endsWith('.model.js') && b.path.endsWith('.model.js') ? a.path.localeCompare(b.path) : 0) : 0) ||
      Number(conversationImports.has(b.path)) - Number(conversationImports.has(a.path)) ||
      (conversationImports.has(a.path) && conversationImports.has(b.path) ? Number(b.path.endsWith('.model.js')) - Number(a.path.endsWith('.model.js')) || (a.path.endsWith('.model.js') && b.path.endsWith('.model.js') ? a.path.localeCompare(b.path) : 0) : 0) ||
      b.rank - a.rank || a.path.localeCompare(b.path));
  const content = render(ranked, budget, counter);
  return { content, files: ranked, tokenCount: counter(content), budget, cacheSize: cache.size };
}

module.exports = { buildRepoMap, pagerank };
