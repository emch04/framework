'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyCorrection, checkReasoningFidelity, toolReliability, calendarConfounders, checkCounterMetrics, reflectionUtility, recommendReflectionFrequency, evaluateLessonConflicts, assessedLessonStatus } = require('../src/autoconscience');
const trace = (extra = {}) => ({ callId: 'c', tool: 'read', provider: 'p', status: 'succeeded', durationMs: 100, labels: ['source_verified'], ...extra });

test('correction classification uses explicit class first; ambiguous tags abstain; prose is not read', () => {
  assert.equal(classifyCorrection({ class: 'style', tags: ['fact_changed'] }), 'style');
  for (const [tag, expected] of [['fact_changed', 'factual'], ['wording_changed', 'style'], ['goal_changed', 'objective'], ['opinion_changed', 'disagreement']]) assert.equal(classifyCorrection({ tags: [tag] }), expected);
  assert.equal(classifyCorrection({ tags: ['fact_changed', 'wording_changed'] }), 'disagreement');
  assert.equal(classifyCorrection({ proposed: 'wrong fact', final: 'correct fact' }), 'disagreement');
  assert.throws(() => classifyCorrection({ class: 'opinion' }), { code: 'invalid_input' });
  assert.throws(() => classifyCorrection({ tags: 'fact_changed' }), { code: 'invalid_input' });
});
test('structured reasoning claims must match successful nonempty actual traces', () => {
  const j = { claims: ['source_verified'] };
  assert.equal(checkReasoningFidelity(j, [trace()]).status, 'faithful');
  for (const traces of [[], [trace({ status: 'failed' })], [trace({ empty: true })], [trace({ labels: [] })]]) assert.equal(checkReasoningFidelity(j, traces).status, 'unfaithful');
  assert.equal(checkReasoningFidelity({ claims: ['unsupported'] }, [trace()]).status, 'unknown');
  assert.equal(checkReasoningFidelity({}, [trace()]).status, 'unknown');
  assert.equal(checkReasoningFidelity({ claims: ['checked'] }, [trace()], { checked: ['source_verified', 'other'] }).status, 'unfaithful');
});
test('tool reliability: failures, empty, slow, p95, provider separation and Wilson', () => {
  const list = [trace({ status: 'failed', durationMs: 6000 }), trace({ empty: true, durationMs: 5000 }), trace(), trace({ provider: 'other' })];
  const [r, other] = toolReliability(list, { minimumSample: 3 });
  assert.deepEqual([r.calls, r.failures, r.emptyResults, r.slowCalls, r.latencyP95Ms], [3, 1, 1, 1, 6000]);
  assert.equal(r.errorRate, 1 / 3); assert.equal(r.emptyRate, 1 / 3); assert.equal(r.slowRate, 1 / 3);
  assert.equal(r.errorStatistics.status, 'observed'); assert.ok(r.errorStatistics.interval.low < 1 / 3);
  assert.equal(other.calls, 1); assert.equal(other.errorStatistics.status, 'insufficient_data');
  assert.deepEqual(toolReliability([]), []);
  assert.throws(() => toolReliability([trace({ durationMs: -1 })]), { code: 'invalid_input' });
});
test('calendar is domain-specific and uses half-open periods; no causal claim is made', () => {
  const calendars = [{ domain: 'd', name: 'calendar', periods: [{ label: 'closure', from: '2026-10-01', to: '2026-10-03', kind: 'closure' }] }];
  assert.equal(calendarConfounders('d', '2026-10-01', calendars).status, 'calendar_confounded');
  assert.equal(calendarConfounders('d', '2026-10-03', calendars).status, 'not_confounded');
  assert.equal(calendarConfounders('other', '2026-10-02', calendars).status, 'not_confounded');
  assert.throws(() => calendarConfounders('d', 'invalid', calendars), { code: 'invalid_input' });
  assert.throws(() => calendarConfounders('d', '2026-10-02', [{ ...calendars[0], periods: [{ from: '2026-10-03', to: '2026-10-01' }] }]), { code: 'invalid_input' });
});
test('anti-Goodhart rejects both directions of regression beyond threshold, accepts equality', () => {
  const target = { name: 'target', direction: 'higher_is_better', before: 0.5, after: 0.7 };
  const high = { name: 'accuracy', direction: 'higher_is_better', before: 10, after: 8, maxRegression: 1 };
  const low = { name: 'errors', direction: 'lower_is_better', before: 1, after: 3, maxRegression: 1 };
  assert.equal(checkCounterMetrics(target, [high]).status, 'rejected'); assert.equal(checkCounterMetrics(target, [low]).status, 'rejected');
  assert.equal(checkCounterMetrics(target, [{ ...high, maxRegression: 2 }]).status, 'accepted');
  assert.equal(checkCounterMetrics({ ...target, after: 0.4 }, [high]).status, 'no_improvement');
  assert.equal(checkCounterMetrics({ ...target, direction: 'lower_is_better', before: 3, after: 1 }, []).status, 'accepted');
  assert.throws(() => checkCounterMetrics(target, [{ ...high, maxRegression: -1 }]), { code: 'invalid_input' });
});
test('meta-reflection counts accepted proposals, useful findings and cost; reduces after N useless completed cycles', () => {
  assert.deepEqual(reflectionUtility({ usefulFindings: 2, acceptedProposals: 1, cost: 1 }), { usefulFindings: 2, acceptedProposals: 1, cost: 1, benefit: 3, utility: 2, useful: true });
  assert.equal(reflectionUtility({ usefulFindings: 1, cost: 2 }).useful, false);
  const runs = Array.from({ length: 3 }, (_, i) => ({ id: `${i}`, status: 'completed', finishedAt: `2026-10-0${i + 1}`, usefulFindings: 0, cost: 0 }));
  assert.equal(recommendReflectionFrequency(runs.slice(0, 2)).recommendation, 'maintain');
  assert.equal(recommendReflectionFrequency([...runs].reverse()).recommendation, 'reduce');
  assert.equal(recommendReflectionFrequency([...runs, { id: '4', status: 'completed', finishedAt: '2026-10-04', acceptedProposals: 1 }]).uselessStreak, 0);
  assert.equal(recommendReflectionFrequency([...runs, { id: '5', status: 'failed', finishedAt: '2026-10-05', usefulFindings: 10 }]).recommendation, 'reduce');
  assert.throws(() => reflectionUtility({ cost: NaN }), { code: 'invalid_input' });
});
test('contradictions need same structured subject, domain and scope; evidence ranking never closes automatically', () => {
  const a = { id: 'a', organisationId: 'o', userId: null, agentId: 'a', domain: 'd', subject: 's', stance: 'supports', status: 'hypothesis', evidence: [{ kind: 'external', ref: 'e' }], sampleSize: 30, evidenceDegree: 'experimental', recordedAt: '2026-10-01' };
  const b = { ...a, id: 'b', stance: 'opposes', sampleSize: 1, recordedAt: '2026-10-02' };
  const conflict = evaluateLessonConflicts([a, b])[0];
  assert.equal(conflict.status, 'open'); assert.equal(conflict.preferredLessonId, 'a'); assert.equal(conflict.newerLessonId, 'b');
  assert.equal(evaluateLessonConflicts([a, { ...b, sampleSize: 30 }])[0].preferredLessonId, null);
  for (const change of [{ domain: 'other' }, { subject: 'other' }, { organisationId: 'other' }, { userId: 'u' }, { agentId: 'b' }, { status: 'retired' }]) assert.equal(evaluateLessonConflicts([a, { ...b, ...change }]).length, 0);
  assert.equal(assessedLessonStatus({ evidence: a.evidence, sampleSize: 29 }), 'hypothesis');
  assert.equal(assessedLessonStatus({ evidence: a.evidence, sampleSize: 30, contradictions: ['b'] }), 'to_reassess');
  assert.equal(assessedLessonStatus({ evidence: a.evidence, sampleSize: 30, factualEligible: false }), 'hypothesis');
});

test('unknown tool status stays outside error-rate denominators', () => {
  const [r] = toolReliability([trace({ status: 'failed' }), trace({ status: 'unknown', empty: true })]);
  assert.equal(r.errorRate, 1); assert.equal(r.knownCalls, 1); assert.equal(r.unknownCalls, 1);
  assert.equal(r.errorStatistics.sampleSize, 1); assert.equal(r.errorStatistics.unknown, 1);
  assert.equal(toolReliability([trace({ status: 'unknown' })])[0].errorRate, null);
});
test('unmeasured completed cycles do not justify reducing reflection frequency', () => {
  assert.equal(reflectionUtility({ cost: 1 }).status, 'unmeasured');
  assert.equal(reflectionUtility({ cost: 1 }).utility, null);
  assert.equal(recommendReflectionFrequency(Array.from({ length: 4 }, (_, i) => ({ id: `${i}`, status: 'completed', cost: 1 }))).recommendation, 'maintain');
});
