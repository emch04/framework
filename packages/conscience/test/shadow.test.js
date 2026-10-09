'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { shadowContract } = require('./shadowContract');
const { createMemoryConscienceStore } = require('../src');
const { createMemoryGovernorStore } = require('../src/governor');
const { createMemoryShadowStore, createPostgresShadowStore, postgresShadowSchema } = require('../src/autoconscience');
const { makeConscience, mask } = require('./helpers');
const api = require('../src/autoconscience');

shadowContract('memory', () => ({ store: createMemoryConscienceStore(), governorStore: createMemoryGovernorStore(), shadowStore: createMemoryShadowStore() }));

test('P4 shadow: the shadow makes no network request of its own and imports no language model', async () => {
  const { governor } = makeConscience({ store: createMemoryConscienceStore(), governorStore: createMemoryGovernorStore() });
  await governor.registerObject({ organisationId: 'o', kind: 'instructions', id: 'main', content: { t: 1 }, by: { kind: 'human', id: 'h' } });
  const proposal = await governor.evaluatePolicy({ organisationId: 'o', target: { kind: 'instructions', id: 'main' }, change: { t: 2 }, proposedBy: { kind: 'engine', id: 'e' }, risk: 'low' });
  await governor.approveProposal(proposal.id, { approver: { kind: 'human', id: 'h' }, organisationId: 'o' });
  await governor.stageChange(proposal.id, { organisationId: 'o', by: { kind: 'engine', id: 'e' } });
  const sandbox = await api.createSandbox({ governor, organisationId: 'o', tools: { call: { kind: 'write' } } });
  const connects = []; const fetches = [];
  const originalConnect = net.Socket.prototype.connect, originalFetch = globalThis.fetch;
  net.Socket.prototype.connect = function connect(...args) { connects.push(args); return originalConnect.apply(this, args); };
  globalThis.fetch = (...args) => { fetches.push(args); return Promise.reject(new Error('no network in tests')); };
  try {
    const shadow = await api.createShadowRunner({ governor, organisationId: 'o', candidate: { kind: 'instructions', id: 'main', agent: async (r, tools) => { await tools.call(r.input); return { ok: true }; } },
      sandbox, sampleRate: 1, budget: { maxRuns: 10 }, masker: mask, metrics: [{ name: 'a', score: () => true }, { name: 'b', score: () => true }], target: 'a' });
    for (let i = 0; i < 5; i++) await shadow.observe({ request: { id: `r${i}`, input: { i } }, stableResult: { output: { ok: true } } }).done;
    assert.equal((await shadow.listRuns()).length, 5);
  } finally { net.Socket.prototype.connect = originalConnect; globalThis.fetch = originalFetch; }
  assert.deepEqual([connects.length, fetches.length], [0, 0]);
  const dir = path.join(__dirname, '../src/autoconscience/shadow');
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(source, /@astratra\/ai|openai|gemini|mistral|groq|ollama|require\('(node:)?(http|https|net|dns|tls|http2|dgram|child_process)'\)|fetch\(/i, file);
  }
});

test('P4 shadow: schema takes a checked prefix and every value travels as a SQL parameter', async () => {
  assert.match(postgresShadowSchema(), /CREATE TABLE IF NOT EXISTS "astratra_shadow_runs"/);
  for (const prefix of ['x; DROP TABLE y', 'a"b', '1abc', 'a'.repeat(60)]) {
    assert.throws(() => postgresShadowSchema({ prefix }));
    assert.throws(() => createPostgresShadowStore({ query() {} }, { prefix }));
  }
  assert.throws(() => createPostgresShadowStore({}));
  const hostile = "x'); DROP TABLE users; --";
  const calls = [];
  const store = createPostgresShadowStore({ async query(sql, params) { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } });
  await store.putShadowRun({ id: hostile, organisationId: hostile, shadowId: hostile, userId: hostile, createdAt: new Date(0).toISOString() });
  await store.getShadowRun(hostile, hostile);
  await store.listShadowRuns({ organisationId: hostile, shadowId: hostile, userId: hostile });
  await store.listShadowRuns({ organisationId: hostile, userId: null });
  await store.removeShadowRuns({ organisationId: hostile, userId: hostile });
  assert.ok(calls.length >= 5);
  for (const call of calls) { assert.doesNotMatch(call.sql, /DROP TABLE users/); assert.ok(!call.sql.includes(hostile)); }
});
