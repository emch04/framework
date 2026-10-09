/** Deterministic P2 evaluation. No language model is imported or consulted. */
import type { Governor } from '../governor';
import type { EvidenceDegree, RecordKind, Conscience, Scope, ToolTrace, Justification, CorrectionClass, LessonVersion, Evidence } from '../index';

export type ReflectionTrigger = 'schedule' | 'idle' | 'volume' | 'on_demand';
export type ReflectionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

/** One reflective cycle. Its lock, budget and checkpoints are those of an @astratra/agent task. */
export interface ReflectionRun {
  id: string; organisationId: string; agentId?: string;
  window: { from: string; to: string };
  trigger: ReflectionTrigger;
  /** Owner of the task lease (TaskStore.acquire of @astratra/agent). */
  lockOwner?: string;
  budget: { maxMs?: number; maxTurns?: number; maxTokens?: number; maxCost?: number };
  model?: string; engineVersion: string;
  startedAt?: string; finishedAt?: string; durationMs?: number; cost?: number;
  findings: string[];
  usefulFindings?: number; acceptedProposals?: number; userId?: string | null;
  status: ReflectionStatus;
  /** Measured benefit of the cycle against its cost (39); null until measured. */
  utility?: number | null;
  checkpoints?: Array<{ step: string; at: string }>;
  /** Why a cycle did not start: too few new decisions, useless recent cycles, budget spent. */
  skippedReason?: string;
}

export interface ReflectionFinding {
  id: string; runId: string; organisationId: string;
  decisionIds: string[]; observation: string; hypothesis?: string;
  evidence: Array<{ kind: RecordKind | 'external'; ref: string }>;
  evidenceDegree: EvidenceDegree;
  confidence: number; severity: 'low' | 'medium' | 'high' | 'critical';
  sampleSize: number;
  kind: string; status: string; agentId?: string; domain?: string; confounders: string[]; details?: unknown;
  /** Descriptive uncertainty interval; null when no known observations exist (10). */
  interval: { low: number; high: number; level: number } | null;
  /** "causality not established" is a legitimate answer (11). */
  causality: 'established' | 'not_established' | 'unknown';
  competingExplanations?: string[];
}

/** Announced probability against observed frequency (01). */
export interface CalibrationPoint { domain: string; organisationId: string; agentId: string; bucket: { low: number; high: number }; predicted: number; observed: number; count: number; window: { from: string; to: string } }

/** A supposed cause with its alternatives and a protocol written before the data is seen (16). */
export interface Hypothesis { id: string; organisationId: string; statement: string; alternatives: string[]; createdAt: string; status: 'open' | 'supported' | 'refuted' | 'inconclusive' }
export interface Experiment {
  id: string; hypothesisId: string; organisationId: string;
  protocol: { registeredAt: string; metrics: string[]; counterMetrics: string[]; cohorts: string[]; minimumSample: number; stopRule?: string };
  /** Experiments run in a sandbox only: simulated tools, no outside effect (32). */
  sandbox: true;
  results?: Record<string, unknown>;
}

/** Weight of each error by its business severity (23). */
export interface ErrorCostPolicy extends Scope { agentId?: string; domain: string; falsePositive: number; falseNegative: number }

/** A measure that must not get worse while another improves (22). */
export interface Metric { name: string; direction: 'higher_is_better' | 'lower_is_better'; before: number; after: number }
export interface CounterMetric extends Metric { maxRegression: number; protectedSet?: boolean }

export interface ToolReliability {
  organisationId?: string; window?: { from: string; to: string }; tool: string; provider: string | null;
  calls: number; knownCalls: number; unknownCalls: number; failures: number; emptyResults: number; slowCalls: number;
  errorRate: number | null; emptyRate: number; slowRate: number;
  errorStatistics: HonestStatistics; emptyStatistics: HonestStatistics; slowStatistics: HonestStatistics; latencyP95Ms: number;
}

/** Business periods taken into account before blaming the agent (29). */
export interface DomainCalendar extends Scope { domain: string; name: string; periods: Array<{ label: string; from: string; to: string; kind: string }> }

/** A candidate strategy observing real requests without acting (21), always in a sandbox (32). */
export interface ShadowRun { id: string; organisationId: string; candidate: { kind: string; id: string; version: string }; baseline: { kind: string; id: string; version: string }; sandbox: true; from: string; to?: string; comparisons: number; status: 'running' | 'stopped' | 'completed' }

export interface StatisticsOptions { minimumSample?: number; level?: 0.9 | 0.95 | 0.99 }
export interface Interval { low: number; high: number; level: number }
export interface HonestStatistics {
  succeeded: number; failed: number; unknown: number; sampleSize: number; minimumSample: number;
  rate: number | null; interval: Interval | null; status: 'observed' | 'insufficient_data';
  conclusion: 'descriptive_only' | 'refuse_to_conclude';
}
export interface PredictionPoint { decisionId: string; agentId: string; domain: string; probability: number; status: 'succeeded' | 'failed' | 'unknown' }
export interface CalibrationResult extends HonestStatistics {
  agentId: string; domain: string; brierScore: number | null; confidenceGap: number | null; overconfidence: number | null; underconfidence: number | null;
  curve: Array<{ bucket: { low: number; high: number }; count: number; predicted: number | null; observed: number | null; interval: Interval | null; status: 'observed' | 'insufficient_data' }>;
}
export interface ErrorCostScore { falsePositives: number; falseNegatives: number; sampleSize: number; unknown: number; totalCost: number; weightedScore: number | null; status: 'observed' | 'insufficient_data' }
export interface CycleOptions { findingWeight?: number; proposalWeight?: number; costWeight?: number; uselessCycles?: number; reductionFactor?: number }
export interface CycleUtility { usefulFindings: number; acceptedProposals: number; cost: number; benefit: number | null; utility: number | null; useful: boolean | null; status?: 'unmeasured' }
export type CycleMeasurement = Pick<ReflectionRun, 'id' | 'organisationId' | 'status'> & Partial<ReflectionRun>;
export interface Conflict { lessonIds: string[]; subject: string; domain: string; status: 'open'; lessonStatus: 'to_reassess'; preferredLessonId: string | null; newerLessonId: string; reason: 'stronger_evidence' | 'inconclusive'; evidence: Evidence[] }
export interface EvaluationInput extends Scope, StatisticsOptions, CycleOptions {
  agentId?: string; window?: { from: string; to: string }; decisionIds?: string[]; runId?: string; signal?: AbortSignal;
  buckets?: number; decisionThreshold?: number; slowMs?: number;
  claimRules?: Readonly<Record<string, readonly string[]>>; calendars?: DomainCalendar[]; errorCostPolicies?: ErrorCostPolicy[];
  targetMetric?: Metric; counterMetrics?: CounterMetric[]; reflectionRuns?: CycleMeasurement[]; competingExplanations?: string[];
}
export interface EvaluateOutcomesOptions extends EvaluationInput { governor: Governor; conscience: Conscience }
export interface Evaluator { evaluate(input: EvaluationInput): Promise<ReflectionFinding[]> }
export type RunReflectionOptions = EvaluateOutcomesOptions;
export function evaluateOutcomes(options: EvaluateOutcomesOptions): Promise<ReflectionFinding[]>;
export function runReflection(options: RunReflectionOptions): Promise<ReflectionFinding[]>;
export function createEvaluator(options: { governor: Governor; conscience: Conscience } & Partial<EvaluationInput>): Evaluator;
export function wilsonInterval(successes: number, total: number, level?: 0.9 | 0.95 | 0.99): Interval | null;
export function honestStatistics(statuses: Array<'succeeded' | 'failed' | 'unknown'>, options?: StatisticsOptions): HonestStatistics;
export function calibratePredictions(points: PredictionPoint[], options?: StatisticsOptions & { buckets?: number }): CalibrationResult[];
export function scoreErrorCosts(points: PredictionPoint[], policy: Pick<ErrorCostPolicy, 'domain' | 'falsePositive' | 'falseNegative'>, options?: StatisticsOptions & { decisionThreshold?: number }): ErrorCostScore;
export function classifyCorrection(input: { class?: CorrectionClass; tags?: string[] }): CorrectionClass;
export function checkReasoningFidelity(justification?: Justification, traces?: ToolTrace[], rules?: Readonly<Record<string, readonly string[]>>): { status: 'unfaithful' | 'faithful' | 'unknown'; unsupported: string[]; uncheckable: string[] };
export function toolReliability(traces: ToolTrace[], options?: StatisticsOptions & { slowMs?: number }): ToolReliability[];
export function calendarConfounders(domain: string, at: string, calendars?: DomainCalendar[]): { status: 'calendar_confounded' | 'not_confounded'; periods: Array<{ calendar: string; label: string; from: string; to: string }> };
export function checkCounterMetrics(target: Metric, counters: CounterMetric[]): { status: 'no_improvement' | 'accepted' | 'rejected'; improvement: number; measures: Array<{ name: string; regression: number; maxRegression: number }>; violations: Array<{ name: string; regression: number; maxRegression: number }> };
export function reflectionUtility(run: Partial<ReflectionRun>, options?: CycleOptions): CycleUtility;
export function recommendReflectionFrequency(runs: CycleMeasurement[], options?: CycleOptions): { recommendation: 'reduce' | 'maintain'; uselessStreak: number; intervalMultiplier: number };
export function evaluateLessonConflicts(lessons: LessonVersion[], options?: StatisticsOptions): Conflict[];
export function oppositeLessons(a: Partial<LessonVersion>, b: Partial<LessonVersion>): boolean;
export function assessedLessonStatus(input: { evidence: Evidence[]; sampleSize: number; contradictions?: string[]; factualEligible?: boolean }, options?: StatisticsOptions): 'hypothesis' | 'verified' | 'to_reassess';
export const DEFAULT_CLAIM_RULES: Readonly<Record<string, readonly string[]>>;
export const AVAILABLE_FROM: 'P2';

/** P3 experiments (first half). Candidate functions are serialized into isolated workers;
 * closures, host callbacks, network and filesystem APIs are unavailable. */
export type ExperimentData = null | boolean | number | string | ExperimentData[] | { [key: string]: ExperimentData };
export type DeepReadonlyExperiment<T> = T extends (...args: any[]) => any ? T : T extends object ? { readonly [K in keyof T]: DeepReadonlyExperiment<T[K]> } : T;
export interface ExperimentBinding { governor: Governor; organisationId: string }
export interface SimulatedToolDescriptor {
  kind: 'read' | 'write' | 'confirm';
  /** Real implementations are ignored, including read tools with side effects. */
  execute?: (...args: any[]) => unknown;
  response?: ExperimentData;
  recordings?: Array<{ input: ExperimentData; output: ExperimentData }>;
}
export type SandboxTools = Record<string, SimulatedToolDescriptor | ((...args: any[]) => unknown)>;
export interface SandboxJournalEntry { sequence: number; tool: string; kind: 'read' | 'write'; input: ExperimentData; simulated: true; caseId?: string }
export interface Sandbox {
  readonly tools: Readonly<Record<string, (input?: ExperimentData) => Promise<ExperimentData>>>;
  getJournal(): Promise<SandboxJournalEntry[]>;
}
export function createSandbox(options: ExperimentBinding & { tools?: SandboxTools }): Promise<Sandbox>;
/** Self-contained function. A model's computation may be embedded here; it never judges scores. */
export type ExperimentAgent = (input: any, tools: Readonly<Record<string, (input?: ExperimentData) => Promise<ExperimentData>>>) => unknown | Promise<unknown>;
export interface ExperimentCase { id: string; input: ExperimentData; expected: ExperimentData }
export interface ExperimentMetric { name: string; kind: 'exact_match'; outputKey?: string; expectedKey?: string }
export interface AggregateExperimentScore { sandbox: true; metrics: Record<string, HonestStatistics> }
export interface ExperimentStageScore extends AggregateExperimentScore { journal?: SandboxJournalEntry[] }
export interface HoldoutAccess { sequence: number; action: 'read_denied' | 'reserved' | 'evaluation_started' | 'evaluation_completed' | 'evaluation_failed' | 'evaluation_denied' | 'registration_failed'; at: string }
export interface HoldoutEvaluationOptions extends StatisticsOptions {
  agent: ExperimentAgent; metrics?: ExperimentMetric[]; tools?: SandboxTools; sandbox?: Sandbox; timeoutMs?: number; organisationId?: string;
}
/** Only provisioning code supplies cases. Never hand their originals to reflection.
 * The handle permits one opaque evaluation; all content reads throw holdout_protected. */
export interface ProtectedHoldout {
  evaluate(options: HoldoutEvaluationOptions): Promise<AggregateExperimentScore>;
  getAccessLog(): Promise<HoldoutAccess[]>;
  read(): never;
}
export function createHoldout(options: ExperimentBinding & { cases: ExperimentCase[] }): Promise<ProtectedHoldout>;
export interface TemporalExperimentData extends Scope { at: string | number; recordedAt: string | number; data: ExperimentData }
export interface ReplayProposal { agent: ExperimentAgent; information?: TemporalExperimentData[] }
export type ReplaySelection = { decisionIds: string[]; window?: never } | { decisionIds?: never; window: { from: import('../index').DateInput; to: import('../index').DateInput } };
export type ReplayDecisionsOptions = ExperimentBinding & Scope & ReplaySelection & {
  conscience: Conscience; proposal: ReplayProposal; asOf: import('../index').DateInput;
  agentId?: string; snapshots?: Record<string, TemporalExperimentData>; tools?: SandboxTools; sandbox?: Sandbox; timeoutMs?: number;
};
export interface ReplayResult {
  purpose: 'compatibility_only'; provesProgress: false; causality: 'not_established'; sandbox: true;
  cases: Array<{ decisionId: string; asOf: string; status: 'completed' | 'unknown'; compatible: boolean | null; output?: ExperimentData; intentions: number; journal: SandboxJournalEntry[] }>;
}
export function replayDecisions(options: ReplayDecisionsOptions): Promise<ReplayResult>;
export interface ExperimentProtocol extends StatisticsOptions {
  development: ExperimentCase[]; validation: ExperimentCase[]; timeoutMs?: number;
  /** Additional plain JSON protocol fields are retained in the frozen fingerprint. */
  [key: string]: unknown;
}
export interface ProposeExperimentOptions extends ExperimentBinding {
  id?: string; hypothesis: string; metrics: ExperimentMetric[]; protocol: ExperimentProtocol;
  thresholds: Record<string, number>; holdout: ProtectedHoldout; agent: ExperimentAgent; tools?: SandboxTools; now?(): number;
}
declare const preregisteredExperiment: unique symbol;
export type RegisteredExperiment = DeepReadonlyExperiment<{
  readonly [preregisteredExperiment]: true;
  id: string; organisationId: string; hypothesis: string; metrics: ExperimentMetric[];
  protocol: ExperimentProtocol & { minimumSample: number; level: 0.9 | 0.95 | 0.99; timeoutMs: number };
  thresholds: Record<string, number>; candidateFingerprint: string; toolsFingerprint: string;
  registrationId: string; registeredAt: string; fingerprint: string; sandbox: true;
}>;
export function proposeExperiment(options: ProposeExperimentOptions): Promise<RegisteredExperiment>;
export interface RunExperimentOptions extends ExperimentBinding {
  experiment: RegisteredExperiment;
  /** Optional repeats are compared with the registration; changes are refused even after execution. */
  protocol?: ExperimentProtocol; metrics?: ExperimentMetric[]; thresholds?: Record<string, number>; hypothesis?: string; agent?: ExperimentAgent; tools?: SandboxTools;
}
export interface ExperimentResult {
  experimentId: string; fingerprint: string; registeredAt: string; sandbox: true;
  decision: 'supported' | 'refuted' | 'inconclusive'; causality: 'not_established'; interval: Interval | null;
  stages: { development: ExperimentStageScore; validation: ExperimentStageScore; holdout: AggregateExperimentScore };
}
export function runExperiment(options: RunExperimentOptions): Promise<ExperimentResult>;
/* P3 · vigilance (2/2). */
export * from './vigilance';
