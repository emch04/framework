import { createConscience, createMemoryConscienceStore, createPostgresConscienceStore, postgresConscienceSchema, frameRecordsForModel, ConscienceError } from './src';
import type { DecisionRecord, ConscienceStore } from './src';
import { createGovernor, createPostgresGovernorStore, postgresGovernorSchema, assertGovernorReady, GovernorError } from './src/governor';
import type { ChangeProposal } from './src/governor';
import { runReflection } from './src/autoconscience';
import type { ReflectionRun, CalibrationPoint } from './src/autoconscience';

const governor = createGovernor({ budgets: { perCycle: 1, perAgent: 5, perOrganisation: 20 } }, { store: createPostgresGovernorStore({ query: async () => ({ rows: [] }) }) });
const store: ConscienceStore = createMemoryConscienceStore();
const conscience = createConscience({ governor, store, masker: (text) => text.replace(/\d/g, '#') });

async function exercise() {
  await assertGovernorReady(governor, { organisationId: 'org' });
  const { decision } = await conscience.recordDecision({
    organisationId: 'org', agentId: 'agent', objective: 'Answer', context: { at: new Date() },
    action: { name: 'reply' }, expectedOutcome: { description: 'Helpful' }, horizon: Date.now() + 1000, confidence: 0.5, versions: { model: 'm' }
  });
  const kept: DecisionRecord = decision;
  await conscience.attachOutcome({ organisationId: 'org', decisionId: kept.id, status: 'unknown', sensor: 'feedback', provenance: { kind: 'feedback', id: 'thumbs' }, observedAt: new Date() });
  const proposal: ChangeProposal = await governor.evaluatePolicy({ organisationId: 'org', target: { kind: 'instructions', id: 'main' }, change: { text: 'x' }, proposedBy: { kind: 'engine', id: 'e' } });
  await governor.approveProposal(proposal.id, { approver: { kind: 'human', id: 'admin' }, organisationId: 'org' });
  const lineage = await conscience.getLineage({ organisationId: 'org' }, kept.id);
  void frameRecordsForModel(lineage?.lessons ?? []);
  void (await conscience.eraseSubject({ organisationId: 'org', userId: 'u' })).removed.decisions;
  void createPostgresConscienceStore({ query: async () => ({ rows: [] }) });
  void postgresConscienceSchema(); void postgresGovernorSchema({ prefix: 'gov' });
  try { await runReflection({ governor, conscience, organisationId: 'org' }); } catch (error) { if (error instanceof ConscienceError || error instanceof GovernorError) void error.code; }
  const run: Partial<ReflectionRun> = { trigger: 'schedule' }; const point: Partial<CalibrationPoint> = { predicted: 0.7 };
  void run; void point;
}
void exercise;

import { evaluateOutcomes, createEvaluator, wilsonInterval, calibratePredictions, scoreErrorCosts, checkReasoningFidelity, classifyCorrection, toolReliability, calendarConfounders, checkCounterMetrics, reflectionUtility, recommendReflectionFrequency } from './src/autoconscience';
async function evaluateTypes() {
  const scope = { organisationId: 'org' };
  const findings = await evaluateOutcomes({ ...scope, governor, conscience, errorCostPolicies: [{ ...scope, domain: 'general', falsePositive: 1, falseNegative: 20 }] });
  void findings[0]?.status;
  void createEvaluator({ governor, conscience }).evaluate(scope);
  const points = [{ decisionId: 'd', agentId: 'a', domain: 'general', probability: 0.8, status: 'succeeded' as const }];
  void calibratePredictions(points)[0]?.curve;
  void scoreErrorCosts(points, { domain: 'general', falsePositive: 1, falseNegative: 10 }).weightedScore;
  void wilsonInterval(5, 10)?.low;
  void checkReasoningFidelity({ claims: ['source_verified'] }, [{ callId: 'c', tool: 'read', durationMs: 10, status: 'succeeded', labels: ['source_verified'] }]);
  void classifyCorrection({ tags: ['wording_changed'] }); void toolReliability([]);
  void calendarConfounders('general', '2026-10-01', [{ ...scope, domain: 'general', name: 'period', periods: [] }]);
  void checkCounterMetrics({ name: 'target', direction: 'higher_is_better', before: 1, after: 2 }, []);
  void reflectionUtility({ cost: 1, usefulFindings: 2 });
  void recommendReflectionFrequency([{ ...scope, id: 'r', status: 'completed', acceptedProposals: 1 }]);
  void conscience.resolveLessonConflict({ ...scope, winnerId: 'a', loserId: 'b', evidence: [] });
}
void evaluateTypes;
