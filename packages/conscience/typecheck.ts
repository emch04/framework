import { createConscience, createMemoryConscienceStore, createPostgresConscienceStore, postgresConscienceSchema, frameRecordsForModel, ConscienceError } from './src';
import type { DecisionRecord, ConscienceStore } from './src';
import { createGovernor, createPostgresGovernorStore, postgresGovernorSchema, assertGovernorReady, GovernorError } from './src/governor';
import type { ChangeProposal, MorningReport, RollbackResult, RejectionSignal } from './src/governor';
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
  const base = { organisationId: 'org', kind: 'instructions', id: 'main' } as const;
  await governor.registerObject({ ...base, content: { text: 'x' }, by: { kind: 'system', id: 'boot' } });
  const staged = await governor.stageChange(proposal.id, { organisationId: 'org', by: { kind: 'engine', id: 'e' } });
  await governor.deployChange({ ...base, percentage: 10, cohorts: ['beta'], by: { kind: 'human', id: 'admin' } });
  const seen = await governor.resolveVersion({ ...base, targetingKey: 'user', attributes: { cohort: 'beta' } });
  const back: RollbackResult = await governor.rollbackChange({ ...base, by: { kind: 'system', id: 'monitor' }, reason: 'drift' });
  await governor.declineProposal(proposal.id, { approver: { kind: 'human', id: 'admin' }, organisationId: 'org', reasonCode: 'poor_tests' });
  const report: MorningReport = await governor.morningReport({ organisationId: 'org', since: new Date() });
  const signals: RejectionSignal[] = await governor.listRejectionSignals({ organisationId: 'org', origin: 'human' });
  void [staged.version.versionId, seen.source, back.mode, report.counts.pending, signals.length, report.rollouts[0]?.percentage];
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

// P3 experiment API, including forbidden content reads and frozen registrations.
import './experiments.typecheck';
import { detectDrift, createFollowUps, followUpEraser, createMemoryVigilanceStore, abstentionPolicy, shouldAbstain, createScenarioLibrary, generateAdversarialCases, lessonToScenario, reviewByRoles } from './src/autoconscience';
async function vigilanceTypes() {
  const scope = { organisationId: 'org' };
  const masker = (text: string) => text.replace(/\d/g, '#');
  const vstore = createMemoryVigilanceStore();
  const report = await detectDrift({ governor, ...scope, agentId: 'a', domain: 'general', baseline: { outcomes: { succeeded: 90, failed: 10 } }, current: { outcomes: { succeeded: 60, failed: 40 } }, propose: {} });
  const action: 'monitor' | 'freeze' | 'investigate' | 'propose_rollback' = report.recommendation;
  const never: false = report.applied;
  const followUps = createFollowUps({ governor, conscience, store: vstore, masker });
  const scheduled = await followUps.scheduleFollowUp({ ...scope, decisionId: 'd', observableAt: new Date(), question: 'Look again.' });
  const due = await followUps.dueFollowUps({ ...scope, now: new Date() });
  void [action, never, scheduled.created, due[0]?.decision.objective, followUpEraser(vstore)];
  const policy = await abstentionPolicy({ governor, ...scope, agentId: 'a', domain: 'general', errorCosts: { falsePositive: 5, falseNegative: 1 } });
  void [policy.threshold, shouldAbstain(policy, { confidence: 0.4 }).recommendation];
  const library = createScenarioLibrary({ governor, store: vstore, masker });
  const generated = await generateAdversarialCases({ governor, ...scope, failures: [{ id: 'f', agentId: 'a', question: 'q' }], masker, library, generator: ({ category }) => ({ question: category }) });
  const candidate = await lessonToScenario({ id: 'l', organisationId: 'org', status: 'verified', evidence: [{ kind: 'outcome', ref: 'o' }] }, { governor, masker, question: 'q', expect: { content: [/ok/] } });
  const suite = (await library.approved(scope)).map((entry) => entry.scenario.id);
  const review = await reviewByRoles({ governor, ...scope, finding: { id: 'f', confidence: 0.6 }, roles: {
    verifier: () => ({ evidence: [{ kind: 'external', ref: 'x' }] }), contradictor: () => ({ competing: [] }), riskController: () => ({ approved: true, maxScope: 'agent' as const }) } });
  void [generated.candidates[0]?.status, candidate.addedToTests, suite, review.advances, review.reviews.verifier.passed];
}
void vigilanceTypes;

import { createShadowRunner, createSandbox as createShadowSandbox, createMemoryShadowStore, shadowEraser } from './src/autoconscience';
import type { ShadowConclusion, ShadowOutcome } from './src/autoconscience';
async function shadowTypes() {
  const sandbox = await createShadowSandbox({ governor, organisationId: 'org', tools: { send: { kind: 'write' }, lookup: { kind: 'read', response: { ok: true } } } });
  const sstore = createMemoryShadowStore();
  const shadow = await createShadowRunner({
    governor, organisationId: 'org', candidate: { kind: 'instructions', id: 'main', agent: async (request, tools) => { await tools.send(request.input); return { answer: 1 }; } },
    sandbox, sampleRate: 0.1, budget: { maxRuns: 100, maxCost: 10, costPerRun: 1, costOf: (run) => run.durationMs / 1000 }, masker: (text: string) => text, store: sstore,
    metrics: [{ name: 'accuracy', score: ({ output }) => output.answer === 1 }, { name: 'sources', critical: true, maxRegression: 0.01, score: () => null }], target: 'accuracy', minimumSample: 30
  });
  const handle = shadow.observe({ request: { id: 'r1', userId: 'u', input: { q: 1 } }, stableResult: { output: { answer: 1 }, durationMs: 4 } });
  const outcome: ShadowOutcome = await handle.done;
  const report = await shadow.report({ propose: {}, recordedBy: { kind: 'system', id: 'shadow' } });
  const conclusion: ShadowConclusion = report.conclusion;
  const never: false = report.provesImprovement;
  const notApplied: false = report.applied;
  const writes: true = report.writeIntentions.neverExecuted;
  const runs = await shadow.listRuns();
  void [outcome, conclusion, never, notApplied, writes, runs[0]?.scores.accuracy.candidate, report.metrics.accuracy.difference?.low, report.criticalRegressions[0]?.stableOutput, shadowEraser(sstore)];
  // @ts-expect-error A proposal and a version cannot both name the candidate.
  void createShadowRunner({ governor, organisationId: 'org', candidate: { proposalId: 'p', kind: 'instructions', id: 'x', agent: async () => 1 }, sandbox, sampleRate: 1, budget: {}, masker: (t: string) => t, metrics: [], target: 'a' });
  // @ts-expect-error The masker is mandatory.
  void createShadowRunner({ governor, organisationId: 'org', candidate: { proposalId: 'p', agent: async () => 1 }, sandbox, sampleRate: 1, budget: {}, metrics: [], target: 'a' });
  // @ts-expect-error The conclusion is never "proven".
  const proven: ShadowConclusion = 'proven';
  void proven;
}
void shadowTypes;

import { createRemoteSettings, remotePolicy, parseRemoteSettings } from './src/governor';
import type { RemoteSettingsState, RemoteDecisionResult } from './src/governor';

async function remoteTypes() {
  const remote = createRemoteSettings({
    read: async () => ({ enabled: true, halted: false, approvers: ['admin'], cyclesPerDay: 2, reflection: { automatic: true, hour: 4, timeZone: 'UTC' } }),
    policy: { budgets: { perCycle: 1, perAgent: 2, perOrganisation: 2 } },
    organisationId: 'org'
  });
  await remote.refresh();
  const state: RemoteSettingsState = remote.current();
  const ruler = remote.governor();
  await remote.sync(ruler);
  const results: RemoteDecisionResult[] = await remote.applyDecisions(ruler, [{ id: 'd1', proposalId: 'p1', decision: 'approve', approver: { kind: 'human', id: 'admin' } }]);
  const due: boolean = remote.reflectionDue();
  void [state.source, results[0]?.result, due, remote.reflectionCycleId(), remotePolicy({ budgets: { perCycle: 1, perAgent: 1, perOrganisation: 1 } }, parseRemoteSettings({ enabled: false, halted: false }))];
  // @ts-expect-error The organisation is required.
  void createRemoteSettings({ read: async () => null, policy: { budgets: { perCycle: 1, perAgent: 1, perOrganisation: 1 } } });
  // @ts-expect-error A decision is approve or decline.
  void remote.applyDecisions(ruler, [{ id: 'd', proposalId: 'p', decision: 'apply', approver: { kind: 'human', id: 'a' } }]);
}
void remoteTypes;

import { createMongoConscienceStore, mongoConscienceIndexes } from './src';
import { createMongoGovernorStore, mongoGovernorIndexes } from './src/governor';
import type { Db, MongoClient } from 'mongodb';
function exerciseMongo(db: Db, client: MongoClient) {
  const memory: ConscienceStore = createMongoConscienceStore(db, { prefix: 'memory' });
  const control = createMongoGovernorStore(db, { prefix: 'governor', client });
  return { memory, control, migrations: Promise.all([mongoConscienceIndexes(db), mongoGovernorIndexes(db)]) };
}
void exerciseMongo;
