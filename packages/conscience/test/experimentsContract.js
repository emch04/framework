'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeConscience, decisionInput, makeClock } = require('./helpers');
const api = require('../src/autoconscience');
const scope = { organisationId: 'org-a' };
const AT = '2026-10-01T08:00:00.000Z';
const LATER = '2026-10-03T08:00:00.000Z';
const samples = (prefix, n = 4) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, input: `${prefix}${i}`, expected: `${prefix}${i}` }));
const registration = (ctx, holdout, extra = {}) => ({ ...scope, governor: ctx.governor,
  hypothesis: 'Returning the input preserves accuracy', metrics: [{ name: 'accuracy', kind: 'exact_match' }],
  protocol: { development: samples('d'), validation: samples('v'), minimumSample: 3, level: 0.95, timeoutMs: 1000 },
  thresholds: { accuracy: 0.3 }, holdout, agent: (input) => input, ...extra });
function experimentsContract(label, makeStores, options = {}) {
  const suite = (name, fn) => test(`${label} P3a: ${name}`, { skip: options.skip }, async () => {
    const stores = await makeStores();
    try { await fn(makeConscience({ ...stores, clock: makeClock(Date.parse(AT)) })); } finally { await stores.cleanup?.(); }
  });
  suite('sandbox replaces real reads and writes; intentions are copies and never execute', async (ctx) => {
    let calls = 0;
    const real = () => { calls++; throw new Error('real tool called'); };
    const sandbox = await api.createSandbox({ ...scope, governor: ctx.governor, tools: {
      read: { kind: 'read', execute: real, response: { count: 2 } },
      write: { kind: 'write', execute: real }, accidental: real
    } });
    assert.deepEqual(await sandbox.tools.read({}), { count: 2 });
    assert.deepEqual(await sandbox.tools.write({ value: 7 }), { simulated: true, intention: true });
    await sandbox.tools.accidental({ value: 9 });
    assert.equal(calls, 0);
    const log = await sandbox.getJournal(); assert.equal(log.length, 3); assert.equal(log[1].kind, 'write');
    log[1].input.value = 99; assert.equal((await sandbox.getJournal())[1].input.value, 7);
    await ctx.governor.halt({ organisationId: scope.organisationId, by: { kind: 'system', id: 'test' } });
    await assert.rejects(sandbox.tools.read({}), { code: 'governor_halted' });
  });
  suite('holdout is unreadable, opaque, journaled and single use; candidate cannot leak inputs', async (ctx) => {
    const holdout = await api.createHoldout({ ...scope, governor: ctx.governor, cases: samples('h') });
    for (const read of [() => holdout.cases, () => holdout.inputs, () => holdout.expected, () => JSON.stringify(holdout), () => Object.keys(holdout)]) assert.throws(read, { code: 'holdout_protected' });
    const score = await holdout.evaluate({ agent: (x) => x, minimumSample: 3 });
    assert.equal(score.metrics.accuracy.rate, 1); assert.equal(score.metrics.accuracy.sampleSize, 4);
    assert.deepEqual(Object.keys(score).sort(), ['metrics', 'sandbox']);
    await assert.rejects(holdout.evaluate({ agent: () => 0 }), { code: 'holdout_consumed' });
    const log = await holdout.getAccessLog(); assert.equal(log.filter((e) => e.action === 'read_denied').length, 5);
    assert.ok(!JSON.stringify(log).includes('expected')); assert.ok(!JSON.stringify(score).includes('h0'));
  });
  suite('replay uses old outcomes and lessons, excludes later revisions; compatibility is not progress', async (ctx) => {
    ctx.clock.advance(-3600000);
    const { decision: earlier } = await ctx.conscience.recordDecision(decisionInput({ id: 'earlier', context: { at: '2026-10-01T07:00:00Z', data: 1 }, inputSnapshotRef: null }));
    const { outcome } = await ctx.conscience.attachOutcome({ ...scope, decisionId: earlier.id, status: 'failed', sensor: 's', observedAt: '2026-10-01T07:00:00Z', provenance: { kind: 'sensor', id: 's' } });
    await ctx.conscience.recordLesson({ ...scope, agentId: 'agent-x', lessonId: 'l', summary: 'old', evidence: [{ kind: 'outcome', ref: outcome.id }] });
    ctx.clock.advance(3600000);
    await ctx.conscience.recordDecision(decisionInput({ id: 'target', context: { at: AT, data: 7 }, inputSnapshotRef: null, action: { name: 'answer', input: 7 } }));
    ctx.clock.advance(2 * 86400000);
    await ctx.conscience.attachOutcome({ ...scope, decisionId: earlier.id, status: 'succeeded', sensor: 's', observedAt: LATER, provenance: { kind: 'sensor', id: 's' } });
    await ctx.conscience.recordLesson({ ...scope, agentId: 'agent-x', lessonId: 'l', summary: 'new' });
    const result = await api.replayDecisions({ ...scope, ...ctx, decisionIds: ['target'], asOf: LATER,
      proposal: { agent: (x) => ({ input: x.inputs, lesson: x.lessons[0].summary, outcome: x.outcomes[0].status }) } });
    assert.deepEqual(result.cases[0].output, { input: 7, lesson: 'old', outcome: 'failed' });
    assert.equal(result.provesProgress, false); assert.equal(result.purpose, 'compatibility_only');
    assert.equal(result.cases[0].compatible, false);
    const compatible = await api.replayDecisions({ ...scope, ...ctx, window: { from: AT, to: LATER }, asOf: LATER, proposal: { agent: (x) => ({ name: 'answer', input: x.inputs }) } });
    assert.equal(compatible.cases[0].compatible, true);
  });
  suite('future snapshot, nested date, backdated outcome, proposal information and late decision are refused', async (ctx) => {
    await ctx.conscience.recordDecision(decisionInput({ id: 'target', context: { at: AT }, inputSnapshotRef: 'snap' }));
    const base = { ...scope, ...ctx, decisionIds: ['target'], asOf: LATER, proposal: { agent: (x) => x.inputs } };
    const snapshot = { ...scope, at: AT, recordedAt: AT, data: 1 };
    for (const patch of [{ at: LATER }, { recordedAt: LATER }, { data: { observedAt: LATER } }]) await assert.rejects(api.replayDecisions({ ...base, snapshots: { snap: { ...snapshot, ...patch } } }), { code: 'future_data' });
    await assert.rejects(api.replayDecisions({ ...base, snapshots: { snap: snapshot }, proposal: { agent: (x) => x, information: [{ ...snapshot, recordedAt: LATER }] } }), { code: 'future_data' });
    await ctx.conscience.attachOutcome({ ...scope, decisionId: 'target', status: 'succeeded', sensor: 's', observedAt: LATER, provenance: { kind: 'sensor', id: 's' } });
    await assert.rejects(api.replayDecisions({ ...base, snapshots: { snap: snapshot } }), { code: 'future_data' });
    ctx.clock.advance(2 * 86400000);
    await ctx.conscience.recordDecision(decisionInput({ id: 'late', context: { at: AT }, inputSnapshotRef: null }));
    await assert.rejects(api.replayDecisions({ ...base, decisionIds: ['late'] }), { code: 'future_data' });
  });
  suite('laboratory preregisters frozen protocol, metrics, thresholds and candidate; runs development then validation then holdout', async (ctx) => {
    const holdout = await api.createHoldout({ ...scope, governor: ctx.governor, cases: samples('h') });
    const input = registration(ctx, holdout);
    const experiment = await api.proposeExperiment(input);
    assert.ok(Object.isFrozen(experiment.protocol.development[0])); assert.match(experiment.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(experiment.registeredAt); input.protocol.development[0].expected = 999;
    const result = await api.runExperiment({ ...scope, governor: ctx.governor, experiment });
    assert.equal(result.decision, 'supported'); assert.equal(result.stages.holdout.metrics.accuracy.rate, 1);
    assert.ok(result.interval.low < 1); assert.equal(result.causality, 'not_established');
    await assert.rejects(api.runExperiment({ ...scope, governor: ctx.governor, experiment, protocol: { ...experiment.protocol, minimumSample: 1 } }), { code: 'protocol_changed' });
    await assert.rejects(api.runExperiment({ ...scope, governor: ctx.governor, experiment }), { code: 'experiment_consumed' });
    const findings = await ctx.governor.listFindings(scope); assert.ok(findings.some((f) => f.code === 'experiment_registered'));
    assert.ok(findings.some((f) => f.code === 'experiment_completed'));
  });
  suite('inconclusive for insufficient data or interval straddling threshold; refuted only by sufficient interval', async (ctx) => {
    for (const [n, agent, threshold, expected] of [[1, (x) => x, 0.3, 'inconclusive'], [4, (x) => x, 0.9, 'inconclusive'], [40, () => -1, 0.5, 'refuted']]) {
      const holdout = await api.createHoldout({ ...scope, governor: ctx.governor, cases: samples('h', n) });
      const experiment = await api.proposeExperiment(registration(ctx, holdout, { agent, thresholds: { accuracy: threshold }, protocol: { development: samples('d', n), validation: samples('v', n), minimumSample: 3 } }));
      assert.equal((await api.runExperiment({ ...scope, governor: ctx.governor, experiment })).decision, expected);
    }
  });
  suite('every entry refuses missing, fake, halted or unavailable governor; isolation is enforced', async (ctx) => {
    for (const fn of [api.createSandbox, api.createHoldout, api.proposeExperiment, api.runExperiment, api.replayDecisions]) {
      assert.equal(typeof fn, 'function');
      await assert.rejects(fn({ ...scope }), { code: 'governor_missing' });
      await assert.rejects(fn({ ...scope, governor: {} }), { code: 'governor_invalid' });
    }
    const holdout = await api.createHoldout({ ...scope, governor: ctx.governor, cases: samples('h') });
    await assert.rejects(api.proposeExperiment(registration(ctx, holdout, { organisationId: 'org-b' })), { code: 'cross_organisation' });
    await ctx.governor.halt({ organisationId: scope.organisationId, by: { kind: 'system', id: 'test' } });
    await assert.rejects(holdout.evaluate({ agent: (x) => x }), { code: 'governor_halted' });
    for (const fn of [api.createSandbox, api.createHoldout, api.proposeExperiment, api.runExperiment, api.replayDecisions]) await assert.rejects(fn({ ...scope, governor: ctx.governor }), { code: 'governor_halted' });
  });
}
module.exports = { experimentsContract, samples, registration, scope, AT, LATER };
