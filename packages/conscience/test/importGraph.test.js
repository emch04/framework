'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const SPECIFIER = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)|\bimport\s*\(\s*(['"`])([^'"`]+)\3\s*\)|\bfrom\s+(['"])([^'"]+)\5/g;

/** Every file reached from `entry` and every bare module it imports. */
function importGraph(entry) {
  const files = new Set(); const external = new Set(); const dynamic = [];
  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    const source = fs.readFileSync(file, 'utf8');
    if (/\brequire\s*\(\s*[^'"`\s)]/.test(source)) dynamic.push(file);
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[2] ?? match[4] ?? match[6];
      if (specifier.startsWith('.')) visit(require.resolve(path.resolve(path.dirname(file), specifier)));
      else external.add(specifier);
    }
  };
  visit(require.resolve(entry));
  return { files: [...files], external: [...external], dynamic };
}

test('the governor imports no language model and no package at all: Node built-ins and its own folder only', () => {
  const graph = importGraph('../src/governor');
  const folder = path.resolve(__dirname, '../src/governor');
  assert.ok(graph.files.length >= 5);
  assert.deepEqual(graph.files.filter((file) => !file.startsWith(folder + path.sep)), [], 'files outside src/governor');
  assert.deepEqual(graph.external.filter((name) => !builtins.has(name)), [], 'non built-in imports');
  assert.deepEqual(graph.dynamic, [], 'computed require() calls');
  for (const file of graph.files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /@astratra\/ai|openai|llama|gemini|mistral|groq|ollama/i, file);
});

test('loading the governor entry loads no AI module at run time', () => {
  const { execFileSync } = require('node:child_process');
  const script = `require(${JSON.stringify(path.resolve(__dirname, '../src/governor'))});
    const loaded = Object.keys(require.cache).filter((f) => !f.includes(${JSON.stringify(path.resolve(__dirname, '../src/governor'))}));
    process.stdout.write(JSON.stringify(loaded));`;
  const loaded = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  assert.deepEqual(loaded, []);
});

test('the test itself sees a forbidden import', () => {
  const graph = importGraph('../src/guard');
  assert.ok(graph.external.includes('@astratra/ai/guards'));
});
