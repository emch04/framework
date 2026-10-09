'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeConscience, decisionInput } = require('./helpers');
const { evaluateOutcomes, runReflection, createEvaluator } = require('../src/autoconscience');

function evaluationContract(label, makeStores, options = {}) {
  const suite = (name, fn) => test(`${label} P2: ${name}`, { skip: options.skip }, async (t) => {
    const stores = await makeStores();
    if (stores.unavailable) { t.skip(stores.unavailable); return; }
    try { await fn(stores); } finally { await stores.cleanup?.(); }
  });
  async function fixture(stores, extra = {}) {
    const ctx = makeConscience({ ...stores, ...extra });
    const scope = { organisationId: 'org-a' };
    const seed = async (id, status = 'succeeded', override = {}) => {
      const { decision } = await ctx.conscience.recordDecision(decisionInput({ id, domain: 'd', ...override }));
      const { prediction } = await ctx.conscience.recordPrediction({ ...scope, decisionId: id, probability: 0.8, statement: 'positive outcome', resolvesBy: '2026-10-08', madeAt: '2026-10-01', sensor: 's' });
      const { outcome } = await ctx.conscience.attachOutcome({ ...scope, decisionId: id, predictionId: prediction.id, status, sensor: 's', observedAt: '2026-10-02', provenance: { kind: 'sensor', id: 's' } });
      return { decision, prediction, outcome };
    };
    const evaluate = (extra = {}) => evaluateOutcomes({ ...scope, ...ctx, ...extra });
    return { ...ctx, scope, seed, evaluate };
  }
  suite('chance success produces no general rule, no causal conclusion and no verified lesson', async (stores) => {
    const { seed, evaluate, conscience, scope } = await fixture(stores);
    const { outcome } = await seed('d1');
    const findings = await evaluate();
    assert.equal(findings.find((f) => f.kind === 'calibration').status, 'insufficient_data');
    assert.equal(findings.find((f) => f.kind === 'outcome').details.generalRule, null);
    assert.ok(findings.every((f) => f.causality === 'not_established'));
    const result = await conscience.recordLesson({ ...scope, domain: 'd', summary: 'candidate', status: 'verified', evidence: [{ kind: 'outcome', ref: outcome.id }] });
    assert.equal(result.lesson.status, 'hypothesis'); assert.equal(result.lesson.sampleSize, 1);
  });
  suite('failed result with faithful method remains distinct; unfaithful justification yields a finding', async (stores) => {
    const { seed, evaluate } = await fixture(stores);
    await seed('good-method', 'failed', { justification: { claims: ['source_verified'] }, toolTrace: [{ callId: 'c', tool: 'read', provider: 'p', status: 'succeeded', durationMs: 10, labels: ['source_verified'] }] });
    await seed('bad-method', 'succeeded', { justification: { claims: ['source_verified'] }, toolTrace: [] });
    const findings = await evaluate();
    const outcome = findings.find((f) => f.kind === 'outcome' && f.decisionIds[0] === 'good-method');
    assert.deepEqual([outcome.details.outcomeStatus, outcome.details.methodStatus], ['failed', 'faithful']);
    assert.equal(findings.find((f) => f.kind === 'reasoning_fidelity' && f.decisionIds[0] === 'bad-method').status, 'unfaithful');
    assert.equal(findings.find((f) => f.kind === 'tool_reliability').sampleSize, 1);
  });
  suite('latest outcomes revise calibration; unknown is preserved and never counted; repeated predictions do not inflate samples', async (stores) => {
    const { seed, evaluate, conscience, scope, clock } = await fixture(stores);
    const { prediction } = await seed('d1', 'unknown');
    let calibration = (await evaluate()).find((f) => f.kind === 'calibration');
    assert.deepEqual([calibration.sampleSize, calibration.details.unknown, calibration.details.brierScore], [0, 1, null]);
    clock.advance(86400000);
    await conscience.attachOutcome({ ...scope, decisionId: 'd1', predictionId: prediction.id, status: 'succeeded', sensor: 's', observedAt: '2026-10-04', provenance: { kind: 'sensor', id: 's' } });
    calibration = (await evaluate()).find((f) => f.kind === 'calibration'); assert.equal(calibration.sampleSize, 1);
    assert.equal((await conscience.getOutcomes(scope, 'd1')).length, 2);
    await conscience.recordPrediction({ ...scope, decisionId: 'd1', probability: 0.9, statement: 'later', madeAt: '2026-10-05', resolvesBy: '2026-10-08', sensor: 's' });
    calibration = (await evaluate()).find((f) => f.kind === 'calibration'); assert.equal(calibration.sampleSize, 0); assert.equal(calibration.details.unknown, 1);
  });
  suite('30 independent known outcomes verify a lesson; duplicate evidence and unknown revisions do not', async (stores) => {
    const { seed, evaluate, conscience, scope } = await fixture(stores);
    const evidence = [];
    for (let i = 0; i < 30; i += 1) evidence.push({ kind: 'outcome', ref: (await seed(`d${i}`, i % 2 ? 'failed' : 'succeeded')).outcome.id });
    const result = await conscience.recordLesson({ ...scope, domain: 'd', summary: 'descriptive regularity', status: 'verified', evidence });
    assert.equal(result.lesson.status, 'verified'); assert.equal(result.lesson.sampleSize, 30);
    assert.equal((await evaluate()).find((f) => f.kind === 'calibration').status, 'observed');
    assert.equal((await conscience.recordLesson({ ...scope, domain: 'd', summary: 'duplicates', status: 'verified', evidence: Array(30).fill(evidence[0]) })).lesson.status, 'hypothesis');
    assert.equal((await conscience.recordLesson({ ...scope, domain: 'other', summary: 'wrong domain', status: 'verified', evidence })).lesson.sampleSize, 0);
  });
  suite('style corrections cannot substantiate factual lessons; application classification and tag rules persist', async (stores) => {
    const { seed, conscience, scope, evaluate } = await fixture(stores, { minimumSample: 1 });
    await seed('d1');
    const { correction } = await conscience.recordCorrection({ ...scope, decisionId: 'd1', tags: ['wording_changed'], proposed: 'a', final: 'b', authorRole: 'reviewer', correctedAt: '2026-10-02' });
    assert.equal(correction.class, 'style');
    const style = await conscience.recordLesson({ ...scope, domain: 'd', summary: 'factual candidate', evidence: [{ kind: 'correction', ref: correction.id }], status: 'verified' });
    assert.equal(style.lesson.status, 'hypothesis');
    const { correction: factual } = await conscience.recordCorrection({ ...scope, decisionId: 'd1', class: 'factual', tags: ['wording_changed'], proposed: 'one', final: 'two', authorRole: 'reviewer', correctedAt: '2026-10-02' });
    const valid = await conscience.recordLesson({ ...scope, domain: 'd', summary: 'fact corrected', evidence: [{ kind: 'correction', ref: factual.id }], status: 'verified' });
    assert.equal(valid.lesson.status, 'verified');
    assert.equal((await evaluate()).find((f) => f.kind === 'correction' && f.evidence[0].ref === correction.id).details.factualLessonEligible, false);
  });
  suite('opposite lessons open symmetric conflicts; evidence-based arbitration keeps history', async (stores) => {
    const { seed, conscience, scope, evaluate } = await fixture(stores, { minimumSample: 1 });
    const { outcome } = await seed('d1');
    const base = { ...scope, agentId: 'agent-x', domain: 'd', subject: 'topic', evidence: [{ kind: 'outcome', ref: outcome.id }], summary: 'structured position', status: 'verified' };
    await conscience.recordLesson({ ...base, lessonId: 'l1', stance: 'supports' });
    await conscience.recordLesson({ ...base, lessonId: 'l2', stance: 'opposes' });
    const a = await conscience.getLesson(scope, 'l1'), b = await conscience.getLesson(scope, 'l2');
    assert.equal(a.current.status, 'to_reassess'); assert.equal(b.current.status, 'to_reassess');
    assert.deepEqual(a.current.contradictions, ['l2']); assert.deepEqual(b.current.contradictions, ['l1']);
    assert.equal(a.history.length, 2);
    assert.equal((await evaluate({ minimumSample: 1 })).find((f) => f.kind === 'contradiction').status, 'to_reassess');
    await assert.rejects(conscience.resolveLessonConflict({ ...scope, winnerId: 'l1', loserId: 'l2', evidence: [] }), { code: 'invalid_input' });
    const resolved = await conscience.resolveLessonConflict({ ...scope, winnerId: 'l1', loserId: 'l2', evidence: base.evidence });
    assert.equal(resolved.winner.status, 'verified'); assert.equal(resolved.loser.status, 'retired');
    assert.equal((await conscience.getLesson(scope, 'l1')).history.length, 3); assert.equal((await conscience.getLesson(scope, 'l2')).history.length, 2);
    assert.equal((await evaluate()).filter((f) => f.kind === 'contradiction').length, 0);
  });
  suite('calendar, error cost, Goodhart and cycle quality assemble into evidence-bearing findings', async (stores) => {
    const { seed, evaluate, scope } = await fixture(stores);
    await seed('d1', 'failed');
    const findings = await evaluate({ minimumSample: 1,
      calendars: [{ ...scope, domain: 'd', name: 'calendar', periods: [{ label: 'closure', from: '2026-10-01', to: '2026-10-03', kind: 'closure' }] }],
      errorCostPolicies: [{ ...scope, domain: 'd', falsePositive: 3, falseNegative: 30 }],
      targetMetric: { name: 'votes', before: 0.5, after: 0.8, direction: 'higher_is_better' },
      counterMetrics: [{ name: 'accuracy', before: 0.9, after: 0.7, direction: 'higher_is_better', maxRegression: 0.1 }],
      reflectionRuns: Array.from({ length: 3 }, (_, i) => ({ ...scope, id: `r${i}`, status: 'completed', cost: 1, usefulFindings: 0, acceptedProposals: 0, finishedAt: `2026-10-0${i + 1}` })) });
    assert.equal(findings.find((f) => f.kind === 'outcome').status, 'calendar_confounded');
    assert.ok(findings.find((f) => f.kind === 'outcome').confounders.includes('closure'));
    assert.equal(findings.find((f) => f.kind === 'error_cost').details.totalCost, 3);
    assert.equal(findings.find((f) => f.kind === 'anti_goodhart').status, 'rejected');
    assert.equal(findings.find((f) => f.kind === 'reflection_quality').details.frequency.recommendation, 'reduce');
    assert.ok(findings.every((f) => f.causality === 'not_established' && Array.isArray(f.evidence)));
  });
  suite('evaluation is deterministic and read-only; governed entry refuses missing, fake and halted governors', async (stores) => {
    const ctx = await fixture(stores); await ctx.seed('d1');
    const first = await ctx.evaluate(); assert.deepEqual(await ctx.evaluate(), first);
    assert.deepEqual(await runReflection({ ...ctx.scope, ...ctx }), first);
    assert.deepEqual(await createEvaluator(ctx).evaluate(ctx.scope), first);
    await assert.rejects(evaluateOutcomes({}), { code: 'governor_missing' });
    await assert.rejects(evaluateOutcomes({ governor: {} }), { code: 'governor_invalid' });
    await ctx.governor.halt({ by: { kind: 'human', id: 'reviewer' } });
    await assert.rejects(ctx.evaluate(), { code: 'governor_halted' });
    await assert.rejects(ctx.conscience.recordLesson({ ...ctx.scope, summary: 'x' }), { code: 'governor_halted' });
  });
  suite('organisation/person/agent isolation, explicit ids and windows; erasure removes derived calibration', async (stores) => {
    const ctx = await fixture(stores); await ctx.seed('d1'); await ctx.seed('d2', 'failed', { userId: 'user-2', agentId: 'agent-y' });
    assert.equal((await ctx.evaluate({ userId: 'user-1' })).find((f) => f.kind === 'calibration').sampleSize, 1);
    assert.equal((await ctx.evaluate({ agentId: 'agent-y' })).find((f) => f.kind === 'calibration').sampleSize, 1);
    assert.equal((await ctx.evaluate({ decisionIds: ['d1', 'd1', 'missing'] })).find((f) => f.kind === 'calibration').sampleSize, 1);
    assert.deepEqual(await ctx.evaluate({ organisationId: 'org-b' }), []);
    assert.deepEqual(await ctx.evaluate({ window: { from: '2026-10-03', to: '2026-10-04' } }), []);
    await assert.rejects(ctx.evaluate({ calendars: [{ organisationId: 'org-b', domain: 'd', name: 'x', periods: [] }] }), { code: 'cross_organisation' });
    await ctx.conscience.eraseSubject({ ...ctx.scope, userId: 'user-1' });
    assert.deepEqual(await ctx.evaluate({ userId: 'user-1' }), []);
  });
  suite('ambiguous sensors abstain and prediction foreign keys are validated', async (stores) => {
    const ctx = await fixture(stores); await ctx.seed('d1');
    await ctx.conscience.recordPrediction({ ...ctx.scope, id: 'unspecific', decisionId: 'd1', statement: 'unspecified sensor', probability: 0.4, madeAt: '2026-10-01', resolvesBy: '2026-10-08' });
    await ctx.conscience.attachOutcome({ ...ctx.scope, decisionId: 'd1', sensor: 's2', status: 'failed', observedAt: '2026-10-02', provenance: { kind: 'sensor', id: 's2' } });
    const calibration = (await ctx.evaluate()).find((f) => f.kind === 'calibration');
    assert.equal(calibration.sampleSize, 1); // only unlinked s2 matches this prediction
    await assert.rejects(ctx.conscience.attachOutcome({ ...ctx.scope, decisionId: 'd1', predictionId: 'missing', sensor: 's', status: 'failed', observedAt: '2026-10-02', provenance: { kind: 'sensor', id: 's' } }), { code: 'not_found' });
  });
}
module.exports = { evaluationContract };
