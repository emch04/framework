'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { vigilanceContract } = require('./vigilanceContract');
const { createMemoryConscienceStore } = require('../src');
const { createMemoryGovernorStore } = require('../src/governor');
const { createMemoryVigilanceStore, populationStabilityIndex, differenceInterval } = require('../src/autoconscience');

vigilanceContract('memory', () => ({ store: createMemoryConscienceStore(), governorStore: createMemoryGovernorStore(), vigilanceStore: createMemoryVigilanceStore() }));

test('P3 vigilance: PSI and Newcombe interval give the values worked out by hand', () => {
  // {a:50,b:50} against {a:80,b:20}, with a 0.5 pseudo-count per category: 0.40629.
  assert.ok(Math.abs(populationStabilityIndex({ a: 50, b: 50 }, { a: 80, b: 20 }).psi - 0.40629) < 1e-4);
  assert.ok(populationStabilityIndex({ a: 50, b: 50 }, { a: 50, b: 50 }).psi < 1e-12);
  assert.equal(populationStabilityIndex({}, { a: 1 }), null);
  const symmetric = populationStabilityIndex({ a: 30, b: 70 }, { a: 60, b: 40 }).psi;
  assert.ok(Math.abs(symmetric - populationStabilityIndex({ a: 60, b: 40 }, { a: 30, b: 70 }).psi) < 1e-12, 'PSI is symmetric');
  const gap = differenceInterval(90, 100, 60, 100);
  assert.ok(Math.abs(gap.difference + 0.3) < 1e-12 && gap.high < 0 && gap.low < gap.difference);
  const none = differenceInterval(50, 100, 50, 100);
  assert.ok(none.low < 0 && none.high > 0 && Math.abs(none.low + none.high) < 1e-9, 'equal proportions: interval centred on zero');
});

test('P3 vigilance: the code imports no language model and no package, and uses no clock or network of its own', () => {
  const dir = path.resolve(__dirname, '../src/autoconscience/vigilance');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 8);
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(source, /openai|llama|gemini|mistral|groq|ollama|fetch\(|node:http|node:net|Math\.random|new Date\(\)/i, name);
    for (const match of source.matchAll(/require\('([^']+)'\)/g)) assert.ok(match[1].startsWith('.'), `${name} requires ${match[1]}`);
  }
});
