/** P4 · shadow mode (21 shadow mode, 32 sandbox of the shadow mode). Deterministic: no language model, nothing is ever applied or promoted. */
import type { Governor, ChangeProposal } from '../../governor';
import type { Interval, HonestStatistics, StatisticsOptions, Sandbox, ExperimentAgent, ExperimentData } from '../index';
import type { Masker, Actor } from '../vigilance';

/** Rows of the shadow store: one ShadowRun per sampled request, already masked. */
export interface ShadowStore {
  putShadowRun(record: ShadowRun): Promise<{ record: ShadowRun; created: boolean }>;
  getShadowRun(organisationId: string, id: string): Promise<ShadowRun | null>;
  listShadowRuns(filter: { organisationId: string; shadowId?: string; userId?: string | null; limit?: number }): Promise<ShadowRun[]>;
  removeShadowRuns(subject: { organisationId: string; userId: string }): Promise<number>;
}
export function createMemoryShadowStore(): ShadowStore;
export function createPostgresShadowStore(db: { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }, options?: { prefix?: string }): ShadowStore;
export function postgresShadowSchema(options?: { prefix?: string }): string;
/** Eraser for `createConscience({ erasers: [...] })`: removes the shadow runs of a person with the rest of their data. */
export function shadowEraser(store: Pick<ShadowStore, 'removeShadowRuns'>): (subject: { organisationId: string; userId: string }) => Promise<{ name: 'shadow_runs'; count: number }>;

export type ShadowConclusion = 'insufficient_data' | 'regression' | 'no_difference' | 'promising';
export const SHADOW_CONCLUSIONS: readonly ShadowConclusion[];
export type ShadowScore = 'succeeded' | 'failed' | 'unknown';

/** A strategy that may run in the shadow: a candidate version of a governor object, or a proposal approved by humans (never a pending or declined one). */
export type ShadowCandidateReference = { proposalId: string; kind?: never; id?: never; versionId?: never } | { kind: string; id: string; versionId?: string; proposalId?: never };
export interface ShadowCandidateInput {
  /**
   * Self-contained function, serialised into the P3 sandbox. Called as `agent({ input, version }, tools)`:
   * `input` is the request, `version` the content of the governed version. A model call can only be a sandbox tool (simulated or recorded).
   */
  agent: ExperimentAgent;
}
export interface ShadowCandidate {
  source: 'version' | 'proposal'; kind: string; id: string; versionId: string | null; proposalId: string | null;
  fingerprint: string; agentFingerprint: string;
}

export interface ShadowMetric {
  /** Lower-case code: `accuracy`, `sources_accuracy`... */
  name: string;
  /** Deterministic judgement of one answer. true: good; false: bad; null: cannot tell (excluded from the statistics). Receives the real request. */
  score(input: { input: any; output: any; side: 'candidate' | 'stable' }): boolean | null | Promise<boolean | null>;
  /** A candidate failure where the stable strategy succeeded is a critical regression (listed, and enough for `regression`). */
  critical?: boolean;
  /** Anti-Goodhart: how much the success rate may drop (absolute, 0 to 1) while the target improves. Default 0.02. */
  maxRegression?: number;
}
export interface ShadowBudget {
  maxRuns?: number; maxCost?: number;
  /** Measured sandbox time. May be exceeded by the runs in flight. */
  maxDurationMs?: number;
  /** Ceiling reserved for one run (default 1). `costOf` can only lower it. */
  costPerRun?: number;
  costOf?(run: { durationMs: number; status: 'completed' | 'failed'; writeIntentions: number; output: any }): number;
  /** Also spend through `governor.authorizeSpend` for this agent: the governor budgets apply and a refusal stops the shadow. */
  governorAgentId?: string;
}
export interface ShadowRunnerOptions extends StatisticsOptions {
  governor: Governor; organisationId: string;
  candidate: ShadowCandidateInput & ShadowCandidateReference;
  /** Built with `createSandbox` for the same governor and organisation. Every tool of the candidate goes through it. */
  sandbox: Sandbox;
  /** Share of the requests, in ]0, 1], decided by a hash of the request id: deterministic and nested. */
  sampleRate: number;
  budget: ShadowBudget;
  /** Required: nothing is stored unmasked. A function, a `@astratra/privacy` redactor, or an object with `mask()`. */
  masker: Masker;
  metrics: ShadowMetric[];
  /** The metric the candidate is meant to improve; every other metric (and `limits.cost`) is a counter-measure. At least one is required. */
  target: string;
  limits?: { cost?: number };
  store?: ShadowStore;
  /** Sandbox time limit of one run (10 to 30000, default 1000). */
  timeoutMs?: number;
  /** Deadline of the whole background work of one request (default timeoutMs + 3000). */
  deadlineMs?: number;
  /** Simultaneous background runs (default 4). More are skipped as `busy`, never queued. */
  maxConcurrent?: number;
  maxCriticalRegressions?: number;
  /** A candidate whose incident rate is significantly above this is a regression (default 0.05). */
  maxIncidentRate?: number;
  id?: string; now?(): number;
}

export interface ShadowObservation {
  request: { id: string; userId?: string | null; input: ExperimentData };
  stableResult: { output: ExperimentData; durationMs?: number; cost?: number };
  /** Recorded results of read tools for this request, replayed to the candidate (never for a write tool). */
  recordings?: Record<string, Array<{ input: ExperimentData; output: ExperimentData }>>;
}
/** What `observe` says in the background. It never carries an answer of the candidate. */
export type ShadowOutcome =
  | { status: 'recorded'; runId: string; created: boolean }
  | { status: 'skipped'; reason: 'not_sampled' | 'busy' | 'duplicate' | 'budget_exhausted' | 'governor_halted' | 'governor_unavailable' | 'governor_budget' | 'candidate_unavailable' | 'candidate_changed' }
  | { status: 'rejected'; reason: 'invalid_input' }
  | { status: 'timeout'; reason: 'deadline' }
  | { status: 'error'; reason: string };
export interface ShadowHandle {
  /** The request was selected and a background run started. */
  scheduled: boolean;
  /** Why it was not, when it was not. */
  reason: string | null;
  /** Never rejects. Do not wait for it before answering the user. */
  done: Promise<ShadowOutcome>;
}

export interface ShadowRun {
  id: string; shadowId: string; organisationId: string; userId: string | null; createdAt: string; sampleRate: number;
  candidate: ShadowCandidate & { status: 'completed' | 'error' | 'timeout'; reason: string | null; output: ExperimentData; outputFingerprint: string };
  request: { input: ExperimentData; fingerprint: string };
  stable: { output: ExperimentData; outputFingerprint: string; durationMs: number | null };
  scores: Record<string, { candidate: ShadowScore; stable: ShadowScore }>;
  /** Same answer from both strategies. */
  agreement: boolean;
  /** Writes the candidate tried: journalled, never executed. */
  writeIntentions: Array<{ sequence: number; tool: string; input: ExperimentData }>;
  toolCalls: { read: number; write: number };
  durationMs: number; cost: number; stableCost: number | null;
  incidents: string[];
}

export interface ShadowMetricReport {
  name: string; critical: boolean; status: 'observed' | 'insufficient_data';
  candidate: HonestStatistics; stable: HonestStatistics;
  paired: { bothSucceeded: number; onlyStableSucceeded: number; onlyCandidateSucceeded: number; bothFailed: number; unknown: number };
  /** Candidate minus stable success rate, Newcombe interval on the Wilson intervals of P2. null below the minimum sample. */
  difference: { difference: number; low: number; high: number; level: number } | null;
}
export interface ShadowReport {
  organisationId: string; shadowId: string; candidate: ShadowCandidate; generatedAt: string;
  conclusion: ShadowConclusion; reasons: string[];
  sample: { runs: number; minimumSample: number; level: number; status: 'observed' | 'insufficient_data'; firstAt: string | null; lastAt: string | null; sampleRates: number[] };
  target: string; metrics: Record<string, ShadowMetricReport>;
  /** The check of P2 (target against counter-measures); null while the target has too few observations. */
  antiGoodhart: null | { target: string; status: 'accepted' | 'rejected' | 'no_improvement'; improvement: number; violations: Array<{ name: string; regression: number; maxRegression: number }>; measures: Array<{ name: string; regression: number; maxRegression: number }>; counterMeasures: number };
  criticalRegressions: Array<{ runId: string; metric: string; createdAt: string; request: { input: ExperimentData; fingerprint: string }; candidateOutput: ExperimentData; stableOutput: ExperimentData; incidents: string[] }>;
  incidents: { runs: number; rate: number | null; interval: Interval | null; byCode: Record<string, number>; status: 'observed' | 'insufficient_data'; maxRate: number };
  agreement: HonestStatistics;
  writeIntentions: { total: number; runsWithWrites: number; byTool: Record<string, number>; neverExecuted: true };
  cost: { total: number | null; mean: number | null; stableMean: number | null };
  durationMs: { mean: number | null; max: number | null };
  stopped: null | { reason: string; at: string };
  /** A shadow comparison on real requests can make an improvement promising, never established. */
  provesImprovement: false; causality: 'not_established'; applied: false;
  /** With `propose` and a promising result: a PENDING proposal at the governor. A human decides; deployment and promotion stay theirs. */
  proposal: ChangeProposal | null;
  finding: unknown | null;
}
export interface ShadowReportOptions extends Partial<StatisticsOptions> {
  propose?: { proposedBy?: Actor; owner?: string; risk?: 'low' | 'medium' | 'high' | 'critical' };
  recordedBy?: Actor;
}
export interface ShadowRunner {
  readonly id: string; readonly candidate: ShadowCandidate; readonly sampleRate: number;
  /**
   * Hands the request and the stable result to the shadow. Synchronous, never throws, never waits: call it when the stable answer is
   * ready (or already sent) and do not await `done`. The candidate answer is stored masked and returned to nobody.
   */
  observe(observation: ShadowObservation): ShadowHandle;
  report(options?: ShadowReportOptions): Promise<ShadowReport>;
  /** Waits for the background runs in progress (tests, shutdown). */
  flush(): Promise<void>;
  listRuns(options?: { limit?: number }): Promise<ShadowRun[]>;
  eraseSubject(subject: { organisationId: string; userId: string }): Promise<{ removed: number }>;
  readonly eraser: (subject: { organisationId: string; userId: string }) => Promise<{ name: 'shadow_runs'; count: number }>;
  stats(): { seen: number; sampled: number; executed: number; recorded: number; skipped: Record<string, number>; errors: Record<string, number>; inflight: number; stopped: { reason: string; at: string } | null };
  /** True once the budget is spent, the kill switch was pulled or the candidate left the candidate state. It does not restart by itself. */
  isStopped(): boolean;
}
export function createShadowRunner(options: ShadowRunnerOptions): Promise<ShadowRunner>;
