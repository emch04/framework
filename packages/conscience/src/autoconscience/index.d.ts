/**
 * @astratra/conscience/autoconscience: types of the reflective engine.
 *
 * This version declares the shapes only. runReflection() checks the governor
 * and then refuses: evaluation arrives in P2 (calibration, honest statistics,
 * cautious causality, contradictions, error costs, reasoning fidelity, tool
 * reliability, calendars, counter-metrics, cycle quality), experiments in P3
 * (time-frozen replay, sandbox, protected test set), shadow mode in P4 and
 * governed rollout in P5. Every result of the engine is a proposal for the
 * governor, never a direct write to anything sensitive.
 */
import type { Governor } from '../governor';
import type { EvidenceDegree, RecordKind } from '../index';

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
  /** Uncertainty interval; null when the sample is too small to conclude (10). */
  interval: { low: number; high: number; level: number } | null;
  /** "causality not established" is a legitimate answer (11). */
  causality: 'established' | 'not_established' | 'unknown';
  competingExplanations?: string[];
}

/** Announced probability against observed frequency (01). */
export interface CalibrationPoint { organisationId: string; agentId: string; bucket: { low: number; high: number }; predicted: number; observed: number; count: number; window: { from: string; to: string } }

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
export interface ErrorCostPolicy { organisationId: string; agentId?: string; costs: Array<{ error: string; weight: number; description?: string }> }

/** A measure that must not get worse while another improves (22). */
export interface CounterMetric { name: string; direction: 'higher_is_better' | 'lower_is_better'; maxRegression: number; protectedSet?: boolean }

export interface ToolReliability { organisationId: string; tool: string; provider?: string; window: { from: string; to: string }; calls: number; failures: number; emptyResults: number; latencyP95Ms?: number }

/** Business periods taken into account before blaming the agent (29). */
export interface DomainCalendar { organisationId: string; name: string; periods: Array<{ label: string; from: string; to: string; kind: string }> }

/** A candidate strategy observing real requests without acting (21), always in a sandbox (32). */
export interface ShadowRun { id: string; organisationId: string; candidate: { kind: string; id: string; version: string }; baseline: { kind: string; id: string; version: string }; sandbox: true; from: string; to?: string; comparisons: number; status: 'running' | 'stopped' | 'completed' }

/** What a P2 evaluator will implement. */
export interface Evaluator {
  evaluate(input: { organisationId: string; window: { from: string; to: string }; signal?: AbortSignal }): Promise<ReflectionFinding[]>;
}

export interface RunReflectionOptions { governor: Governor; organisationId?: string; agentId?: string; trigger?: ReflectionTrigger; signal?: AbortSignal }

/** Checks the governor (governor_missing, governor_invalid, governor_unavailable, governor_halted), then throws not_available before P2. */
export function runReflection(options: RunReflectionOptions): Promise<never>;
export const AVAILABLE_FROM: 'P2';
