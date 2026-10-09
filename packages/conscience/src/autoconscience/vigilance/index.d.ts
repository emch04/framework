/** P3, second half: vigilance. Deterministic: no language model, nothing is ever applied by itself. */
import type { Governor, ChangeProposal } from '../../governor';
import type { Conscience, DecisionRecord } from '../../index';
import type { CalibrationResult, DomainCalendar, ErrorCostPolicy, Interval, ReflectionFinding, StatisticsOptions } from '../index';

/** Structurally the scenario of evaluateAgent in @astratra/testkit (this package does not depend on it). */
export interface EvaluateAgentScenario {
  id: string; question: string;
  tools?: Array<{ name: string; run(args: Record<string, unknown>, context?: any): unknown | Promise<unknown> }>;
  expect?: { tools?: string[]; content?: Array<string | RegExp> };
  score?(input: { text: string; calls: Array<{ name: string; args: Record<string, unknown> }>; output: unknown; checks: Array<{ name: string; passed: boolean }> }): number | Promise<number>;
}

export type Masker = ((text: string) => string | Promise<string>) | { redactString(text: string): string } | { mask(text: string): string };
export interface Actor { kind: 'engine' | 'model' | 'human' | 'system'; id: string }

/* ---------- 17 · drift ---------- */
export type DriftRecommendation = 'monitor' | 'freeze' | 'investigate' | 'propose_rollback';
export interface WindowSummary {
  window?: { from: string | Date; to: string | Date };
  inputs?: { domains?: Record<string, number>; languages?: Record<string, number>; lengths?: number[] };
  outcomes?: { succeeded: number; failed: number; unknown?: number };
  performance?: {
    calibration?: { sampleSize: number; brierScore: number | null; confidenceGap: number | null };
    tools?: Array<{ tool: string; provider?: string | null; knownCalls: number; failures: number }>;
  };
}
export interface DriftSignal {
  id: string; dimension: 'inputs' | 'outcomes' | 'performance'; metric: string;
  test: 'psi' | 'newcombe_difference' | 'threshold_difference';
  status: 'observed' | 'insufficient_data'; level: 'none' | 'moderate' | 'significant' | null; drifted: boolean | null;
  statistic: number | null; direction: 'shift' | 'degradation' | 'improvement' | 'unchanged' | null;
  baselineSample: number; currentSample: number; threshold: number; details: Record<string, unknown> | null;
}
export interface RecentChange { kind: string; id: string; version: string; previousVersion: string; deployedAt: string | Date }
export interface DetectDriftOptions extends StatisticsOptions {
  governor: Governor; organisationId: string; agentId: string; domain: string;
  baseline: WindowSummary; current: WindowSummary;
  /** P2 calendars of the same organisation: a period that overlaps the current window and not the baseline explains a shift. */
  calendars?: DomainCalendar[];
  recentChange?: RecentChange;
  minimumEffect?: number; brierDelta?: number; confidenceGapDelta?: number; freezeDrop?: number;
  /** Turns a rollback recommendation into a PENDING proposal at the governor. Never applies it. */
  propose?: { proposedBy?: Actor; owner?: string; risk?: 'low' | 'medium' | 'high' | 'critical' };
  recordedBy?: Actor; runId?: string;
}
export interface DriftReport {
  organisationId: string; agentId: string; domain: string;
  status: 'stable' | 'watch' | 'drift' | 'insufficient_data'; signals: DriftSignal[];
  calendar: { status: 'not_checked' | 'explains' | 'does_not_explain'; periods: Array<{ calendar: string; label: string; from: string; to: string; kind: string | null }> };
  attribution: 'none' | 'calendar' | 'agent_or_environment'; reexamineAfter: string | null;
  recommendation: DriftRecommendation; reasons: string[];
  recentChange: (Omit<RecentChange, 'deployedAt'> & { deployedAt: string }) | null;
  /** Always false: detection never applies anything. */
  applied: false; proposal: ChangeProposal | null; finding: unknown | null;
}
export function detectDrift(options: DetectDriftOptions): Promise<DriftReport>;
export function snapshotWindow(input: { decisions?: DecisionRecord[]; findings?: ReflectionFinding[]; agentId?: string; domain?: string; languageOf?: (decision: DecisionRecord) => string | null | undefined; window?: { from: string; to: string } }): WindowSummary;
export function populationStabilityIndex(baseline: Record<string, number>, current: Record<string, number>): { psi: number; categories: number; top: Array<{ category: string; baseline: number; current: number; contribution: number }> } | null;
export function differenceInterval(s1: number, n1: number, s2: number, n2: number, level?: 0.9 | 0.95 | 0.99): { difference: number; low: number; high: number; level: number };
export const DRIFT_RECOMMENDATIONS: readonly DriftRecommendation[];

/* ---------- 18 · prospective memory ---------- */
export interface VigilanceStore {
  putFollowUp(record: FollowUp): Promise<{ record: FollowUp; created: boolean }>;
  getFollowUp(organisationId: string, id: string): Promise<FollowUp | null>;
  listFollowUps(filter: { organisationId: string; userId?: string | null; decisionId?: string; status?: string; observableTo?: string; limit?: number }): Promise<FollowUp[]>;
  updateFollowUp(organisationId: string, id: string, expectedStatus: string, patch: Partial<FollowUp>): Promise<FollowUp | null>;
  removeFollowUps(filter: { organisationId: string; userId: string }): Promise<number>;
  putCandidate(record: ScenarioCandidate): Promise<{ record: ScenarioCandidate; created: boolean }>;
  getCandidate(organisationId: string, id: string): Promise<ScenarioCandidate | null>;
  listCandidates(filter: { organisationId: string; agentId?: string | null; limit?: number }): Promise<ScenarioCandidate[]>;
}
export interface FollowUp {
  id: string; organisationId: string; userId: string | null; agentId: string; decisionId: string;
  observableAt: string; question: string; status: 'scheduled' | 'done'; fingerprint: string;
  createdAt: string; completedAt: string | null; outcomeRef: string | null;
}
export interface DueFollowUp {
  followUp: FollowUp;
  decision: { id: string; agentId: string; domain?: string; objective: string; expectedOutcome: DecisionRecord['expectedOutcome']; horizon: string };
}
export interface FollowUps {
  /** Same decision, date and question: same follow-up (created: false). Another organisation's decision: not_found. */
  scheduleFollowUp(input: { organisationId: string; userId?: string; decisionId: string; observableAt: string | Date; question: string; id?: string }): Promise<{ followUp: FollowUp; created: boolean }>;
  /** Scheduled follow-ups whose date has come (`now` defaults to the clock), oldest first. */
  dueFollowUps(input: { organisationId: string; userId?: string; now?: string | Date; limit?: number }): Promise<DueFollowUp[]>;
  completeFollowUp(input: { organisationId: string; id: string; outcomeRef?: string }): Promise<{ followUp: FollowUp; completed: boolean }>;
  listFollowUps(input: { organisationId: string; userId?: string; decisionId?: string; status?: 'scheduled' | 'done'; limit?: number }): Promise<FollowUp[]>;
  eraseSubject(input: { organisationId: string; userId: string }): Promise<{ removed: number }>;
  /** Pass it in createConscience({ erasers: [followUps.eraser] }) (or use followUpEraser(store) before the follow-ups exist). */
  readonly eraser: (subject: { organisationId: string; userId: string }) => Promise<{ name: string; count: number }>;
}
export function createFollowUps(options: { governor: Governor; conscience: Conscience; store: VigilanceStore; masker: Masker; now?: () => number }): FollowUps;
export function followUpEraser(store: Pick<VigilanceStore, 'removeFollowUps'>): FollowUps['eraser'];
export const FOLLOW_UP_STATUSES: readonly ['scheduled', 'done'];

/* ---------- 26 · abstention ---------- */
export interface AbstentionOptions extends StatisticsOptions {
  governor: Governor; organisationId: string; agentId: string; domain: string;
  calibration?: CalibrationResult; findings?: ReflectionFinding[];
  errorCosts?: Pick<ErrorCostPolicy, 'falsePositive' | 'falseNegative'>; errorCostPolicy?: Pick<ErrorCostPolicy, 'falsePositive' | 'falseNegative'>;
  /** Threshold in force today (default: the prudent default). */
  currentThreshold?: number; defaultThreshold?: number;
  propose?: { proposedBy?: Actor; owner?: string; risk?: 'low' | 'medium' | 'high' | 'critical' };
}
export interface AbstentionPolicy {
  organisationId: string; agentId: string; domain: string;
  /** Computed threshold. Not in force until a human approves the proposal. */
  threshold: number; effectiveThreshold: number;
  basis: 'calibration_and_costs' | 'insufficient_data' | 'no_reliable_region'; status: 'computed' | 'prudent_default';
  costRatio: number | null; sampleSize: number; minimumSample: number;
  region: { from: number; sampleSize: number; rate: number; interval: Interval | null } | null;
  reasons: string[]; belowThreshold: { recommendation: 'ask_clarification'; alternative: 'propose_verification' };
  changeRequired: boolean; applied: false; proposal: ChangeProposal | null;
}
export function abstentionPolicy(options: AbstentionOptions): Promise<AbstentionPolicy>;
export function shouldAbstain(policy: Pick<AbstentionPolicy, 'effectiveThreshold'>, input: { confidence: number; actionKind?: string }): { abstain: boolean; threshold: number; recommendation: 'proceed' | 'ask_clarification' | 'propose_verification' };
export const ABSTENTION_DEFAULT_THRESHOLD: 0.8;

/* ---------- 27 and 03 · scenarios to review ---------- */
export type ScenarioCategory = 'injection' | 'ambiguity' | 'edge_case' | 'cross_organisation' | 'regression';
export type CandidateStatus = 'to_review' | 'approved' | 'declined' | 'rejected' | 'expired';
export interface ScenarioSpec {
  question: string;
  /** Simulated tools: fixed results, no effect on anything. */
  tools: Array<{ name: string; returns: unknown }>;
  expect: { tools: string[]; content: Array<string | { regex: string; flags: string }> };
  forbiddenTools: string[]; forbiddenContent: string[];
}
export interface ScenarioCandidate {
  id: string; organisationId: string; agentId: string | null; category: ScenarioCategory;
  origin: Record<string, unknown>; source: 'template' | 'generator' | 'template_fallback' | 'lesson';
  /** Starts as "to_review"; "approved" only when humans approved exactly this content at the governor. */
  status: CandidateStatus; addedToTests: boolean; scenario: ScenarioSpec; fingerprint: string; proposalId: string | null; createdAt: string;
}
export interface ScenarioLibrary {
  submit(candidates: ScenarioCandidate[], input: { organisationId: string; proposedBy?: Actor }): Promise<Array<{ candidate: ScenarioCandidate; created: boolean; proposal: ChangeProposal }>>;
  list(input: { organisationId: string; agentId?: string | null; status?: CandidateStatus; limit?: number }): Promise<ScenarioCandidate[]>;
  /** The only way into the test suite. */
  approved(input: { organisationId: string; agentId?: string | null }): Promise<Array<{ candidate: ScenarioCandidate; scenario: EvaluateAgentScenario }>>;
  toScenario(candidate: ScenarioCandidate): EvaluateAgentScenario;
}
export function createScenarioLibrary(options: { governor: Governor; store: VigilanceStore; masker: Masker; now?: () => number; targetKind?: 'instructions' | 'threshold' | 'tool_description' | 'routing' }): ScenarioLibrary;
export function scenarioToTestkit(candidate: ScenarioCandidate): EvaluateAgentScenario;

export interface FailureInput { id: string; agentId: string; domain?: string; question: string; organisationId?: string }
/** Injected generator: returns data only (a partial description), never code. */
export type AdversarialGenerator = (input: { category: ScenarioCategory; failure: Required<Omit<FailureInput, 'organisationId'>>; template: Partial<ScenarioSpec>; signal?: AbortSignal }) => Partial<Pick<ScenarioSpec, 'question' | 'tools' | 'forbiddenTools' | 'forbiddenContent'>> & { expect?: { tools?: string[]; content?: string[] } } | Promise<unknown>;
export function generateAdversarialCases(options: {
  governor: Governor; organisationId: string; failures: FailureInput[]; masker: Masker; generator?: AdversarialGenerator;
  categories?: Array<Exclude<ScenarioCategory, 'regression'>>; limit?: number; locale?: 'en' | 'fr'; library?: ScenarioLibrary; proposedBy?: Actor; now?: () => number; signal?: AbortSignal;
}): Promise<{ candidates: ScenarioCandidate[]; rejected: Array<{ failureId: string; category: string; reason: 'generator_invalid' | 'generator_error' }>; submitted: boolean }>;
export const ADVERSARIAL_CATEGORIES: readonly Exclude<ScenarioCategory, 'regression'>[];

export function lessonToScenario(lesson: { id: string; organisationId: string; status: string; agentId?: string | null; domain?: string | null; revisionId?: string; evidence: Array<{ kind: string; ref: string }> }, options: {
  governor: Governor; masker: Masker; question: string; tools?: Array<{ name: string; returns?: unknown }>;
  expect?: { tools?: string[]; content?: Array<string | RegExp> }; forbiddenTools?: string[]; forbiddenContent?: string[];
  organisationId?: string; agentId?: string; library?: ScenarioLibrary; proposedBy?: Actor; now?: () => number;
}): Promise<ScenarioCandidate>;
export const SCENARIO_CATEGORIES: readonly ScenarioCategory[];
export const CANDIDATE_STATUSES: readonly CandidateStatus[];

/* ---------- 14 · multi-role review ---------- */
export type ReviewScope = 'observation' | 'agent' | 'domain' | 'organisation';
export interface ReviewedFinding { id: string; organisationId?: string; confidence: number; requestedScope?: ReviewScope; decisionIds?: string[]; evidence?: Array<{ kind: string; ref: string }>; [key: string]: unknown }
export interface RoleContext { organisationId: string; role: 'verifier' | 'contradictor' | 'riskController'; signal?: AbortSignal }
export interface ReviewRoles {
  verifier(finding: Readonly<ReviewedFinding>, context: RoleContext): { evidence: Array<{ kind: 'decision' | 'prediction' | 'outcome' | 'correction' | 'external'; ref: string; organisationId?: string }> } | Promise<unknown>;
  contradictor(finding: Readonly<ReviewedFinding>, context: RoleContext): { competing: Array<{ statement: string; strength: number }> } | Promise<unknown>;
  riskController(finding: Readonly<ReviewedFinding>, context: RoleContext): { approved: boolean; maxScope: ReviewScope; reasons?: string[] } | Promise<unknown>;
}
export interface RoleReview { role: string; passed: boolean; blockers: string[]; error?: string; [key: string]: unknown }
export interface RoleReviewResult {
  findingId: string; organisationId: string; advances: boolean; status: 'supported' | 'hypothesis'; blockers: string[];
  reviews: { verifier: RoleReview; contradictor: RoleReview; riskController: RoleReview };
  finding: ReviewedFinding & { status: 'supported' | 'hypothesis' }; recorded: unknown | null;
}
export function reviewByRoles(options: {
  governor: Governor; organisationId: string; finding: ReviewedFinding; roles: ReviewRoles;
  minimumIndependent?: number; evidenceExists?: (item: { kind: string; ref: string; organisationId: string }) => boolean | Promise<boolean>;
  recordedBy?: Actor; runId?: string; signal?: AbortSignal;
}): Promise<RoleReviewResult>;
export const REVIEW_ROLES: readonly ['verifier', 'contradictor', 'riskController'];
export const REVIEW_SCOPES: readonly ReviewScope[];

/* ---------- stores ---------- */
export function createMemoryVigilanceStore(): VigilanceStore;
export function createPostgresVigilanceStore(db: { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }, options?: { prefix?: string }): VigilanceStore;
export function postgresVigilanceSchema(options?: { prefix?: string }): string;
