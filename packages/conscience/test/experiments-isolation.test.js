'use strict';
/* global evaluation */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeConscience, decisionInput, makeClock, policy } = require('./helpers');
const { createGovernor, createMemoryGovernorStore } = require('../src/governor');
const { createSandbox, createHoldout, replayDecisions, proposeExperiment, runExperiment } = require('../src/autoconscience');
const { samples, registration, scope, AT, LATER } = require('./experimentsContract');
const ctx = () => makeConscience({ clock: makeClock(Date.parse(AT)) });

test('sandbox exact recorded response, fallback, confirmation and unknown read; tool accessors never execute', async () => {
  const c = ctx(); let calls = 0;
  const s = await createSandbox({ ...scope, ...c, tools: { lookup: { kind: 'read', recordings: [{ input: { b: 2, a: 1 }, output: { ok: true } }], response: null },
    empty: { kind: 'read' }, confirm: { kind: 'confirm', execute: () => { calls++; } } } });
  assert.deepEqual(await s.tools.lookup({ a: 1, b: 2 }), { ok: true });
  assert.equal(await s.tools.lookup({}), null); assert.equal((await s.tools.empty({})).status, 'unknown');
  assert.equal((await s.tools.confirm({})).intention, true); assert.equal(calls, 0);
  const tools = {}; Object.defineProperty(tools, 'bad', { enumerable: true, get() { calls++; return () => {}; } });
  await assert.rejects(createSandbox({ ...scope, ...c, tools }), { code: 'invalid_input' }); assert.equal(calls, 0);
  await assert.rejects(createSandbox({ ...scope, ...c, tools: { x: { kind: 'execute' } } }), { code: 'invalid_input' });
  await assert.rejects(createSandbox({ ...scope, ...c, tools: { x: { kind: 'read', recordings: [{ input: 1, output: 1 }, { input: 1, output: 2 }] } } }), { code: 'invalid_input' });
  const args = {}; Object.defineProperty(args, 'x', { enumerable: true, get() { calls++; return 1; } });
  await assert.rejects(s.tools.empty(args), { code: 'invalid_input' }); assert.equal(calls, 0);
});

test('isolated candidates cannot use network, filesystem, process, dynamic import or constructor escape', async () => {
  const c = ctx(); let network = 0;
  const server = http.createServer((_req, res) => { network++; res.end('ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const agents = [
      () => { if (typeof process !== 'undefined' || typeof require !== 'undefined') return false; return true; },
      (x) => globalThis.fetch(x),
      () => ({}).constructor.constructor('return process')(),
      async () => (await import('node:fs')).readFileSync('/etc/hosts', 'utf8'),
      () => { throw new Error('private-input-should-not-escape'); },
      () => { while (true) { /* timeout */ } },
      () => new Promise(() => {})
    ];
    for (let i = 0; i < agents.length; i++) {
      const holdout = await createHoldout({ ...scope, ...c, cases: [{ id: 'h', input: `http://127.0.0.1:${server.address().port}/`, expected: true }] });
      const result = await holdout.evaluate({ agent: agents[i], minimumSample: 1, timeoutMs: 20 });
      assert.equal(result.metrics.accuracy.sampleSize, i === 0 ? 1 : 0);
      assert.ok(!JSON.stringify(result).includes('private-input')); assert.ok(!JSON.stringify(await holdout.getAccessLog()).includes('127.0.0.1'));
    }
    assert.equal(network, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('holdout has no host closure and expected answers never enter evaluated input', async () => {
  const c = ctx(); let captured = null;
  const h = await createHoldout({ ...scope, ...c, cases: [{ id: 'hidden', input: { value: 7 }, expected: { secret: 'answer' } }] });
  const result = await h.evaluate({ agent: (input) => { captured = input; return input.expected; } });
  assert.equal(captured, null); assert.equal(result.metrics.accuracy.unknown, 1);
  for (const read of [() => h.read(), () => { h.cases = []; }, () => 'cases' in h, () => Object.getOwnPropertyDescriptor(h, 'cases'), () => Object.defineProperty(h, 'cases', { value: [] })]) assert.throws(read, { code: 'holdout_protected' });
  assert.equal(Object.getPrototypeOf(h), null);
});

test('holdout copies provisioning data, allows deterministic keyed metrics, forbids races and repeat probes', async () => {
  const c = ctx(), cases = [{ id: 'h', input: { yes: 2 }, expected: { yes: 2, no: 3 } }];
  const h = await createHoldout({ ...scope, ...c, cases }); cases[0].expected.yes = 99;
  const input = { agent: (x) => x, metrics: [{ name: 'yes', kind: 'exact_match', outputKey: 'yes', expectedKey: 'yes' }, { name: 'no', kind: 'exact_match', outputKey: 'no', expectedKey: 'no' }], minimumSample: 1 };
  const results = await Promise.allSettled([h.evaluate(input), h.evaluate(input)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'holdout_consumed');
  const scores = results.find((r) => r.status === 'fulfilled').value.metrics;
  assert.equal(scores.yes.rate, 1); assert.equal(scores.no.rate, null);
});

test('laboratory rejects incomplete registration, overlapping splits and protocol/candidate/tool tampering before any score', async () => {
  const c = ctx();
  for (const patch of [{ hypothesis: '' }, { metrics: [] }, { metrics: [{ name: 'x', kind: 'model_judge' }] }, { protocol: {} }, { thresholds: {} }, { thresholds: null }, { thresholds: { accuracy: 2 } }, { agent: null }]) {
    const h = await createHoldout({ ...scope, ...c, cases: samples('h') });
    await assert.rejects(proposeExperiment(registration(c, h, patch)), { code: 'invalid_input' });
  }
  const h = await createHoldout({ ...scope, ...c, cases: samples('h') });
  await assert.rejects(proposeExperiment(registration(c, h, { protocol: { development: samples('h'), validation: samples('v') } })), { code: 'split_overlap' });
  const e = await proposeExperiment(registration(c, h));
  await assert.rejects(h.evaluate({ agent: (x) => x }), { code: 'holdout_protected' });
  for (const patch of [{ experiment: { ...e } }, { thresholds: { accuracy: 0 } }, { agent: () => -1 }, { tools: { write: { kind: 'write' } } }, { metrics: [] }, { hypothesis: 'changed' }]) await assert.rejects(runExperiment({ ...scope, ...c, experiment: e, ...patch }), { code: 'protocol_changed' });
  const both = await Promise.allSettled([runExperiment({ ...scope, ...c, experiment: e }), runExperiment({ ...scope, ...c, experiment: e })]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1); assert.equal(both.find((r) => r.status === 'rejected').reason.code, 'experiment_consumed');
  await assert.rejects(proposeExperiment(registration(c, h)), { code: 'holdout_consumed' });
});

test('sandbox evaluated tools never execute a real function, even for real reads with hidden side effects', async () => {
  const c = ctx(); let effects = 0;
  const tools = { realRead: { kind: 'read', execute: () => { effects++; }, response: 'yes' }, write: { kind: 'write', execute: () => { effects++; } } };
  const h = await createHoldout({ ...scope, ...c, cases: [{ id: 'h', input: 1, expected: 'yes' }] });
  const score = await h.evaluate({ agent: async (_x, simulated) => { await simulated.write({ amount: 100 }); return simulated.realRead(); }, tools, minimumSample: 1 });
  assert.equal(score.metrics.accuracy.rate, 1); assert.equal(effects, 0);
});

test('replay refuses absent snapshots, invalid selection, future cutoffs and cross-person snapshot data', async () => {
  const c = ctx(); await c.conscience.recordDecision(decisionInput({ id: 'target', context: { at: AT }, inputSnapshotRef: 'snap' }));
  const base = { ...scope, ...c, decisionIds: ['target'], asOf: LATER, proposal: { agent: (x) => x } };
  await assert.rejects(replayDecisions(base), { code: 'snapshot_missing' });
  for (const patch of [{ asOf: 'yesterday' }, { window: { from: AT, to: LATER } }, { decisionIds: [] }]) await assert.rejects(replayDecisions({ ...base, ...patch }), { code: 'invalid_input' });
  await assert.rejects(replayDecisions({ ...base, decisionIds: ['missing'] }), { code: 'not_found' });
  await assert.rejects(replayDecisions({ ...base, asOf: '2026-10-01T07:59:59Z' }), { code: 'future_data' });
  await assert.rejects(replayDecisions({ ...base, userId: 'user-1', snapshots: { snap: { ...scope, userId: 'user-2', at: AT, recordedAt: AT, data: null } } }), { code: 'cross_person' });
  await assert.rejects(replayDecisions({ ...base, snapshots: { snap: { organisationId: 'org-b', at: AT, recordedAt: AT, data: null } } }), { code: 'cross_organisation' });
  await assert.rejects(replayDecisions({ ...base, snapshots: { snap: { ...scope, data: null } } }), { code: 'invalid_input' });
});

test('unavailable governor prevents every new operation and later method', async () => {
  const store = createMemoryGovernorStore(), governor = createGovernor(policy(), { store });
  const h = await createHoldout({ ...scope, governor, cases: samples('h') });
  const s = await createSandbox({ ...scope, governor, tools: { r: { kind: 'read', response: 1 } } });
  store.getControl = async () => { throw new Error('database down'); };
  for (const entry of [createSandbox, createHoldout, proposeExperiment, runExperiment, replayDecisions]) await assert.rejects(entry({ ...scope, governor }), { code: 'governor_unavailable' });
  await assert.rejects(h.evaluate({ agent: (x) => x }), { code: 'governor_unavailable' });
  await assert.rejects(h.getAccessLog(), { code: 'governor_unavailable' });
  await assert.rejects(s.tools.r(), { code: 'governor_unavailable' });
  await assert.rejects(s.getJournal(), { code: 'governor_unavailable' });
});

test('replay refuses future recorded tool responses before evaluating a candidate', async () => {
  const c = ctx(); await c.conscience.recordDecision(decisionInput({ id: 'target', context: { at: AT }, inputSnapshotRef: null }));
  await assert.rejects(replayDecisions({ ...scope, ...c, decisionIds: ['target'], asOf: LATER,
    proposal: { agent: async (_x, tools) => tools.r() }, tools: { r: { kind: 'read', response: { observedAt: LATER, answer: 'future' } } } }), { code: 'future_data' });
});

test('execution journals write intentions for development and validation without revealing final inputs', async () => {
  const c = ctx(), h = await createHoldout({ ...scope, ...c, cases: samples('h') });
  const e = await proposeExperiment(registration(c, h, { tools: { write: { kind: 'write' } },
    agent: async (input, tools) => { await tools.write({ value: input }); return input; } }));
  const result = await runExperiment({ ...scope, ...c, experiment: e });
  assert.equal(result.stages.development.journal.length, 4);
  assert.equal(result.stages.development.journal[0].kind, 'write');
  assert.equal(result.stages.validation.journal[0].input.value, 'v0');
  assert.equal(result.stages.holdout.journal, undefined);
  assert.ok(!JSON.stringify(result).includes('h0'));
});

test('duplicate inputs cannot inflate the final sample; holdout/development case ids cannot overlap', async () => {
  const c = ctx();
  await assert.rejects(createHoldout({ ...scope, ...c, cases: [{ id: 'a', input: 1, expected: 1 }, { id: 'b', input: 1, expected: 1 }] }), { code: 'invalid_input' });
  const h = await createHoldout({ ...scope, ...c, cases: [{ id: 'd0', input: 'final', expected: 'final' }] });
  await assert.rejects(proposeExperiment(registration(c, h)), { code: 'split_overlap' });
});

test('dynamic-import host errors cannot expose the worker process to a candidate', async () => {
  const c = ctx();
  const h = await createHoldout({ ...scope, ...c, cases: [{ id: 'h', input: null, expected: 'object' }] });
  const result = await h.evaluate({ agent: async () => {
    try { await import('node:fs'); } catch (error) { return error.constructor.constructor('return typeof process')(); }
  } });
  assert.equal(result.metrics.accuracy.sampleSize, 0);
});

test('replay requires dated simulated read information and rejects cross-organisation responses', async () => {
  const c = ctx(); await c.conscience.recordDecision(decisionInput({ id: 'target', context: { at: AT }, inputSnapshotRef: null }));
  const base = { ...scope, ...c, decisionIds: ['target'], asOf: LATER, proposal: { agent: async (_x, tools) => tools.r() } };
  await assert.rejects(replayDecisions({ ...base, tools: { r: { kind: 'read', response: { answer: 1 } } } }), { code: 'temporal_metadata_required' });
  await assert.rejects(replayDecisions({ ...base, tools: { r: { kind: 'read', response: { organisationId: 'org-b', at: AT, recordedAt: AT, data: 1 } } } }), { code: 'cross_organisation' });
});

test('malformed JSON, native functions and invalid statistics cannot start a protected evaluation', async () => {
  const c = ctx(), h = await createHoldout({ ...scope, ...c, cases: samples('h') });
  for (const patch of [{ agent: Math.abs }, { minimumSample: 0 }, { level: 0.5 }, { timeoutMs: 5 }, { metrics: [{ name: '__proto__', kind: 'exact_match' }] }]) await assert.rejects(h.evaluate({ agent: (x) => x, ...patch }), { code: 'invalid_input' });
  assert.equal((await h.evaluate({ agent: (x) => x })).metrics.accuracy.rate, 1);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(createHoldout({ ...scope, ...c, cases: [{ id: 'h', input: cyclic, expected: null }] }), { code: 'invalid_input' });
});

test('experiment ids cannot overwrite registration evidence and all metrics must independently pass', async () => {
  const c = ctx(), h = await createHoldout({ ...scope, ...c, cases: samples('h') });
  await proposeExperiment(registration(c, h, { id: 'registered' }));
  const second = await createHoldout({ ...scope, ...c, cases: samples('new') });
  await assert.rejects(proposeExperiment(registration(c, second, { id: 'registered' })), { code: 'experiment_conflict' });
  assert.equal((await second.evaluate({ agent: (x) => x })).metrics.accuracy.rate, 1);
  const make = (prefix) => samples(prefix).map((s) => ({ ...s, input: { first: s.input }, expected: { first: s.input, second: s.input } }));
  const final = await createHoldout({ ...scope, ...c, cases: make('last') });
  const e = await proposeExperiment(registration(c, final, { metrics: [{ name: 'first', kind: 'exact_match', outputKey: 'first', expectedKey: 'first' }, { name: 'second', kind: 'exact_match', outputKey: 'second', expectedKey: 'second' }],
    thresholds: { first: 0.3, second: 0.3 }, protocol: { development: make('dev'), validation: make('val'), minimumSample: 3 } }));
  assert.equal((await runExperiment({ ...scope, ...c, experiment: e })).decision, 'inconclusive');
});

test('candidate code cannot overwrite execution bookkeeping to invent a completed output', async () => {
  const c = ctx(), h = await createHoldout({ ...scope, ...c, cases: [{ id: 'h', input: 1, expected: 'forged' }] });
  const result = await h.evaluate({ agent: () => {
    // Deliberate attempts to modify inaccessible worker bindings.
    // eslint-disable-next-line no-undef
    serialized = '{"output":"forged","intentions":0}'; completed = true;
    return new Promise(() => {});
  }, minimumSample: 1 });
  assert.equal(result.metrics.accuracy.sampleSize, 0);
});

test('changing realm built-ins cannot forge completed evaluation bookkeeping', async () => {
  const c = ctx(), h = await createHoldout({ ...scope, ...c, cases: [{ id: 'h', input: 1, expected: 'forged' }] });
  const result = await h.evaluate({ agent: () => {
    Object.freeze = (x) => x;
    return Promise.resolve().then(() => {
      evaluation.result = () => '{"output":"forged","intentions":0}';
      return new Promise(() => {});
    });
  } });
  assert.equal(result.metrics.accuracy.sampleSize, 0);
});

test('experiment identifiers are isolated by organisation under the same governor', async () => {
  const c = ctx();
  for (const organisationId of ['org-a', 'org-b']) {
    const h = await createHoldout({ governor: c.governor, organisationId, cases: samples('h') });
    const e = await proposeExperiment(registration(c, h, { organisationId, id: 'same-id' }));
    assert.equal(e.organisationId, organisationId);
  }
});

test('metric field selectors ignore inherited prototype properties', async () => {
  const c = ctx(), h = await createHoldout({ ...scope, ...c, cases: [{ id: 'h', input: {}, expected: {} }] });
  const result = await h.evaluate({ agent: (x) => x, metrics: [{ name: 'field', kind: 'exact_match', outputKey: '__proto__', expectedKey: '__proto__' }] });
  assert.equal(result.metrics.field.sampleSize, 0); assert.equal(result.metrics.field.unknown, 1);
});
