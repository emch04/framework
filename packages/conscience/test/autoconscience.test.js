'use strict';
const { evaluationContract } = require('./evaluationContract');
const { createMemoryConscienceStore } = require('../src');
const { createMemoryGovernorStore } = require('../src/governor');
evaluationContract('memory', () => ({ store: createMemoryConscienceStore(), governorStore: createMemoryGovernorStore() }));

const { test } = require('node:test');
const { AbortController } = globalThis;
const assert = require('node:assert/strict');
const { makeConscience, decisionInput } = require('./helpers');
const { evaluateOutcomes } = require('../src/autoconscience');

test('P2: late unknown invalidates verification while recorded history is retained', async () => {
  const { conscience, clock } = makeConscience({ minimumSample: 1 });
  const scope = { organisationId: 'org-a' };
  const { decision } = await conscience.recordDecision(decisionInput());
  const { outcome } = await conscience.attachOutcome({ ...scope, decisionId: decision.id, status: 'succeeded', sensor: 's', observedAt: '2026-10-02', provenance: { kind: 'sensor', id: 's' } });
  const { lesson } = await conscience.recordLesson({ ...scope, summary: 'observation', evidence: [{ kind: 'outcome', ref: outcome.id }], status: 'verified' });
  assert.equal(lesson.status, 'verified');
  clock.advance(86400000);
  await conscience.attachOutcome({ ...scope, decisionId: decision.id, status: 'unknown', sensor: 's', observedAt: '2026-10-03', provenance: { kind: 'sensor', id: 's' } });
  const read = await conscience.getLesson(scope, lesson.id);
  assert.equal(read.current.status, 'hypothesis'); assert.equal(read.current.sampleSize, 0); assert.equal(read.history[0].status, 'verified');
  assert.equal((await conscience.listLessons(scope, { status: 'verified' })).length, 0);
  assert.equal((await conscience.getLesson(scope, lesson.id, { asOf: lesson.recordedAt })).current.status, 'verified');
});
test('P2: simultaneous opposed lessons are assessed as open conflicts on subsequent reads', async () => {
  const { conscience } = makeConscience();
  const base = { organisationId: 'org-a', domain: 'd', subject: 'topic', summary: 'position' };
  await Promise.all([conscience.recordLesson({ ...base, lessonId: 'a', stance: 'supports' }), conscience.recordLesson({ ...base, lessonId: 'b', stance: 'opposes' })]);
  assert.ok((await conscience.listLessons({ organisationId: 'org-a' })).every((l) => l.status === 'to_reassess'));
});
test('P2: evaluation aborts, invalid windows and mismatched governor fail clearly', async () => {
  const ctx = makeConscience(); const scope = { organisationId: 'org-a' };
  await ctx.conscience.recordDecision(decisionInput());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(evaluateOutcomes({ ...ctx, ...scope, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(evaluateOutcomes({ ...ctx, ...scope, window: { from: 'invalid', to: '2026-10-03' } }), { code: 'invalid_input' });
  await assert.rejects(evaluateOutcomes({ ...ctx, ...scope, conscience: makeConscience().conscience }), { code: 'invalid_input' });
});
test('P2: unchanged factual corrections cannot manufacture a verified lesson', async () => {
  const { conscience } = makeConscience({ minimumSample: 1 });
  const scope = { organisationId: 'org-a' };
  const { decision } = await conscience.recordDecision(decisionInput());
  const { correction } = await conscience.recordCorrection({ ...scope, decisionId: decision.id, class: 'factual', proposed: 'same fact', final: 'same fact', authorRole: 'reviewer', correctedAt: '2026-10-02' });
  const { lesson } = await conscience.recordLesson({ ...scope, summary: 'candidate', status: 'verified', evidence: [{ kind: 'correction', ref: correction.id }] });
  assert.equal(lesson.status, 'hypothesis'); assert.equal(lesson.sampleSize, 0);
});
