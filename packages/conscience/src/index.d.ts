import type { Governor, Queryable } from './governor';
export { assertGovernorReady, isGovernor, GovernorError } from './governor';

export type RecordKind = 'decision' | 'prediction' | 'outcome' | 'correction' | 'lesson' | 'self_model';
export type OutcomeStatus = 'succeeded' | 'failed' | 'unknown';
export type CorrectionClass = 'factual' | 'style' | 'objective' | 'disagreement';
export type LessonStatus = 'hypothesis' | 'verified' | 'to_reassess' | 'retired';
export type EvidenceDegree = 'none' | 'anecdotal' | 'observational' | 'experimental' | 'replicated';
export type EvidenceKind = 'decision' | 'prediction' | 'outcome' | 'correction' | 'external';
export type ProvenanceKind = 'sensor' | 'tool' | 'human' | 'feedback' | 'system' | 'model';
export type DateInput = string | number | Date;

/** Read and write scope: one organisation, optionally one person. */
export interface Scope { organisationId: string; userId?: string | null }
export interface Provenance { kind: ProvenanceKind; id: string }

export interface ToolTrace { callId: string; tool: string; provider?: string | null; status: OutcomeStatus; empty?: boolean; durationMs: number; labels?: string[] }
export interface Justification { claims?: string[] }

export interface DecisionInput extends Scope {
  domain?: string; justification?: Justification; toolTrace?: ToolTrace[];
  /** Stable id; derived from the content when absent (the same decision twice is one row). */
  id?: string;
  agentId: string;
  objective: string;
  /** Dated context. `data` strings are masked before storage. */
  context: { at: DateInput; summary?: string; data?: unknown };
  action: { name: string; kind?: string; input?: unknown };
  alternatives?: Array<string | { name: string; reason?: string }>;
  expectedOutcome: { description: string; metric?: string; target?: unknown };
  /** When the outcome should be observable. */
  horizon: DateInput;
  /** 0 to 1. */
  confidence: number;
  permissions?: string[];
  versions: { model?: string; tools?: unknown; instructions?: string };
  /** Reference to a snapshot of the inputs, kept by your application. */
  inputSnapshotRef?: string;
  tools?: Array<{ name: string; version?: string; callId?: string }>;
  /** Defaults to context.at. */
  decidedAt?: DateInput;
}

export interface DecisionRecord {
  domain: string; justification: Justification; toolTrace: ToolTrace[];
  id: string; organisationId: string; userId: string | null; agentId: string; objective: string;
  context: { at: string; summary: string | null; data: unknown };
  action: { name: string; kind: string | null; input: unknown };
  alternatives: Array<{ name: string; reason: string | null }>;
  expectedOutcome: { description: string; metric: string | null; target: unknown };
  horizon: string; confidence: number; permissions: string[];
  versions: { model: string | null; tools: unknown; instructions: string | null };
  inputSnapshotRef: string | null; tools: Array<{ name: string; version: string | null; callId: string | null }>;
  decidedAt: string; recordedAt: string; subjectErased?: boolean;
}

export interface PredictionInput extends Scope { domain?: string; sensor?: string; id?: string; decisionId: string; statement: string; probability: number; resolvesBy: DateInput; madeAt?: DateInput }
export interface PredictionRecord { domain: string; sensor: string | null; id: string; organisationId: string; userId: string | null; agentId: string; decisionId: string; statement: string; probability: number; resolvesBy: string; madeAt: string; recordedAt: string }

export interface OutcomeInput extends Scope {
  predictionId?: string;
  id?: string; decisionId: string; status: OutcomeStatus; observation?: string; sensor: string; sources?: string[];
  /** 0 (certain) to 1 (no idea). */
  uncertainty?: number; confounders?: string[]; provenance: Provenance; observedAt: DateInput;
}
export interface OutcomeRecord {
  predictionId: string | null;
  id: string; organisationId: string; userId: string | null; agentId: string; decisionId: string; status: OutcomeStatus;
  observation: string | null; sensor: string; sources: string[]; uncertainty: number | null; confounders: string[];
  provenance: Provenance; observedAt: string; recordedAt: string;
  /** Previous outcome of the same sensor when this one was recorded. */
  revises: string | null;
}
export interface OutcomeVersion extends OutcomeRecord { revision: number; current: boolean; supersededAt: string | null }

export interface CorrectionInput extends Scope {
  id?: string; decisionId: string;
  /** What the agent proposed and the final version. Masked, then only the difference is kept. */
  proposed: string; final: string;
  class?: CorrectionClass; tags?: Array<'fact_changed' | 'wording_changed' | 'goal_changed' | 'opinion_changed'>; authorRole: string; correctedAt: DateInput;
}
export interface MaskedDelta { removed: string; added: string; removedWords: number; addedWords: number; totalWordsBefore: number; totalWordsAfter: number; unchanged: boolean }
export interface CorrectionRecord { id: string; organisationId: string; userId: string | null; agentId: string; decisionId: string; class: CorrectionClass; authorRole: string; correctedAt: string; delta: MaskedDelta; recordedAt: string }

export interface Evidence { kind: EvidenceKind; ref: string; note?: string | null }
export interface LessonInput extends Scope {
  domain?: string; subject?: string | null; stance?: 'supports' | 'opposes' | null; factual?: boolean; minimumSample?: number;
  /** Same lessonId = a new revision of the same lesson. */
  lessonId?: string; agentId?: string; summary: string; evidence?: Evidence[]; evidenceDegree?: EvidenceDegree;
  /** Computed from evidence and independent sample size; open conflicts force to_reassess. */
  status?: LessonStatus;
  validFrom?: DateInput; validUntil?: DateInput; contradictions?: string[]; supersedes?: string[];
  consent?: unknown; retention?: unknown; scenarioRef?: string;
}
export interface MemoryLesson {
  domain: string; subject: string | null; stance: 'supports' | 'opposes' | null; factual: boolean; minimumSample: number; sampleSize: number; factualEligible: boolean;
  id: string; revisionId: string; previousRevision: string | null; contentFingerprint: string;
  organisationId: string; userId: string | null; agentId: string | null; summary: string;
  evidence: Array<{ kind: EvidenceKind; ref: string; note: string | null }>; evidenceDegree: EvidenceDegree; status: LessonStatus;
  validFrom: string | null; validUntil: string | null; contradictions: string[]; supersedes: string[];
  consent: unknown; retention: unknown; scenarioRef: string | null; statusForced: boolean; recordedAt: string;
}
export interface LessonVersion extends MemoryLesson { storedStatus?: LessonStatus; revision: number; current: boolean; supersededAt: string | null }

export interface SelfModelInput extends Scope {
  agentId: string;
  /** Each capability needs test evidence (scenario ids, reports): nothing is assumed. */
  capabilities?: Array<{ name: string; evidence: string[]; score?: number; testedAt?: DateInput }>;
  tools?: Array<{ name: string; version?: string }>; limits?: string[]; permissions?: string[]; domains?: string[];
  metrics?: Record<string, number>; provenance: Provenance; at?: DateInput;
}
export interface SelfModelSnapshot {
  id: string; revisionId: string; previousRevision: string | null; contentFingerprint: string;
  organisationId: string; userId: string | null; agentId: string;
  capabilities: Array<{ name: string; evidence: string[]; score: number | null; testedAt: string | null }>;
  tools: Array<{ name: string; version: string | null }>; limits: string[]; permissions: string[]; domains: string[];
  metrics: Record<string, number>; provenance: Provenance; at: string; recordedAt: string;
}

export interface TimelineEntry {
  kind: RecordKind; id: string; revisionId: string | null; revision: number; current: boolean; decisionId: string | null;
  /** When it happened. */ eventAt: string | null;
  /** When it was written down. */ recordedAt: string;
  validFrom: string | null; validUntil: string | null;
  /** Recording time of the next revision. */ supersededAt: string | null;
  status: string | null;
}

export interface Lineage {
  objective: string; decision: DecisionRecord; action: DecisionRecord['action']; tools: DecisionRecord['tools'];
  predictions: PredictionRecord[]; outcomes: OutcomeVersion[]; corrections: CorrectionRecord[]; lessons: LessonVersion[];
  chain: ['objective', 'action', 'tools', 'outcomes', 'corrections', 'lessons'];
}

export interface ErasureReport {
  organisationId: string; mode: 'delete' | 'anonymise';
  removed: { decisions: number; predictions: number; outcomes: number; corrections: number; lessons: number };
  anonymised: number;
  /** Lessons of the organisation that cited erased records: references removed, back to 'hypothesis' when none is left. */
  lessonsUpdated: number;
  extensions: Array<{ name: string; count: number }>;
  completedAt: string;
}

/** What a store keeps: an immutable envelope with indexed columns and the record itself in `data`. */
export interface RecordEnvelope<T = any> {
  kind: RecordKind; id: string; organisationId: string; userId: string | null; agentId: string | null;
  decisionId: string | null; lessonId: string | null; eventAt: string | null; recordedAt: string;
  fingerprint: string; evidenceRefs: string[]; data: T;
}
export interface RecordFilter {
  organisationId: string; userId?: string | null; agentId?: string | null; decisionId?: string | null; lessonId?: string | null;
  decisionIds?: string[]; evidenceRef?: string; eventFrom?: string; eventTo?: string;
  /** Inclusive upper bound on recordedAt ("as of"). */ recordedTo?: string;
  limit?: number; order?: 'asc' | 'desc';
}
/**
 * Storage of the conscience. Five methods; see README to write one for
 * another database. Order: recordedAt, then insertion order.
 */
export interface ConscienceStore {
  /** Insert once; an existing (organisationId, kind, id) is returned unchanged with created: false. */
  put(envelope: RecordEnvelope): Promise<{ record: RecordEnvelope; created: boolean }>;
  get(kind: RecordKind, organisationId: string, id: string): Promise<RecordEnvelope | null>;
  list(kind: RecordKind, filter: RecordFilter): Promise<RecordEnvelope[]>;
  /** Erasure and retention only. */
  replace(envelope: RecordEnvelope): Promise<RecordEnvelope | null>;
  remove(kind: RecordKind, organisationId: string, ids: string[]): Promise<number>;
}

export type Masker = ((text: string) => string | Promise<string>) | { redactString(text: string): string } | { mask(text: string): string | Promise<string> };

export interface ConscienceOptions {
  /** Minimum independent known outcomes/factual corrections for verification; default 30. */
  minimumSample?: number;
  /** Required: built by createGovernor() of @astratra/conscience/governor. */
  governor: Governor;
  /** Required: applied to every free text before storage. Should be deterministic. */
  masker: Masker;
  /** Default: memory store (lost on exit). */
  store?: ConscienceStore;
  now?(): number;
  retention?: {
    /** What eraseSubject does. Default 'delete'. */
    erasure?: 'delete' | 'anonymise';
    /** Used by applyRetention() only; nothing is deleted on a timer. */
    maxAgeDays?: Partial<Record<RecordKind, number>>;
  };
  /** Called by eraseSubject for data kept elsewhere (vectors, indexes, caches, calibrations). */
  erasers?: Array<(subject: { organisationId: string; userId: string }) => Promise<{ name: string; count: number }> | { name: string; count: number }>;
  onEvent?(event: { type: 'conscience'; action: string; organisationId: string; [key: string]: unknown }): void | Promise<void>;
}

export interface Conscience {
  readonly store: ConscienceStore;
  readonly governor: Governor;
  readonly retention: { erasure: 'delete' | 'anonymise'; maxAgeDays: Partial<Record<RecordKind, number>> };
  recordDecision(input: DecisionInput): Promise<{ decision: DecisionRecord; created: boolean }>;
  recordPrediction(input: PredictionInput): Promise<{ prediction: PredictionRecord; created: boolean }>;
  /** A later outcome of the same sensor is a new revision; the earlier one is kept. */
  attachOutcome(input: OutcomeInput): Promise<{ outcome: OutcomeVersion; created: boolean }>;
  recordCorrection(input: CorrectionInput): Promise<{ correction: CorrectionRecord; created: boolean }>;
  /** Reflective write: requires a ready governor. */
  recordLesson(input: LessonInput): Promise<{ lesson: MemoryLesson; created: boolean; statusForced: boolean }>;
  /** Reflective write: requires a ready governor. */
  resolveLessonConflict(input: Scope & { winnerId: string; loserId: string; evidence: Evidence[] }): Promise<{ winner: MemoryLesson; loser: MemoryLesson }>;
  updateSelfModel(input: SelfModelInput): Promise<{ snapshot: SelfModelSnapshot; created: boolean }>;
  getDecision(scope: Scope, id: string): Promise<DecisionRecord | null>;
  getOutcomes(scope: Scope & { asOf?: DateInput }, decisionId: string): Promise<OutcomeVersion[]>;
  recallDecisions(scope: Scope, query?: { agentId?: string; from?: DateInput; to?: DateInput; asOf?: DateInput; limit?: number; order?: 'asc' | 'desc'; withOutcomes?: boolean }): Promise<Array<DecisionRecord & { outcomes?: OutcomeVersion[] }>>;
  getLesson(scope: Scope, lessonId: string, options?: { asOf?: DateInput }): Promise<{ current: LessonVersion; history: LessonVersion[] } | null>;
  listLessons(scope: Scope, filter?: { agentId?: string; status?: LessonStatus; validAt?: DateInput; asOf?: DateInput }): Promise<LessonVersion[]>;
  getSelfModel(scope: Scope, agentId: string, options?: { asOf?: DateInput }): Promise<SelfModelSnapshot | null>;
  getSelfModelHistory(scope: Scope, agentId: string): Promise<Array<SelfModelSnapshot & { revision: number; current: boolean; supersededAt: string | null }>>;
  getMemoryTimeline(scope: Scope, query?: { axis?: 'event' | 'recorded'; from?: DateInput; to?: DateInput; asOf?: DateInput; validAt?: DateInput; kinds?: RecordKind[]; agentId?: string }): Promise<TimelineEntry[]>;
  getLineage(scope: Scope, decisionId: string): Promise<Lineage | null>;
  eraseSubject(subject: { organisationId: string; userId: string }): Promise<ErasureReport>;
  applyRetention(options: { organisationId: string }): Promise<{ organisationId: string; removed: Partial<Record<RecordKind, number>>; lessonsUpdated: number; completedAt: string }>;
}

export function createConscience(options: ConscienceOptions): Conscience;
export function createMemoryConscienceStore(): ConscienceStore;
export function createPostgresConscienceStore(db: Queryable, options?: { prefix?: string }): ConscienceStore;
export function postgresConscienceSchema(options?: { prefix?: string }): string;
/** Memory guard: frames stored text as untrusted data before a model reads it. */
export function frameStoredText(text: string, options?: { source?: string; nonce?: string }): string;
export function frameRecordsForModel(records: unknown, options?: { source?: string; nonce?: string }): string;
export function wordDelta(before: string, after: string): MaskedDelta;
export function matchesFilter(envelope: RecordEnvelope, filter: RecordFilter): boolean;

export class ConscienceError extends Error {
  code: 'invalid_input' | 'organisation_required' | 'not_found' | 'conflict' | 'evidence_not_found' | 'capability_without_evidence'
    | 'masker_required' | 'masker_invalid' | 'store_invalid' | 'not_available' | string;
  constructor(code: string, message: string);
}

export const RECORD_KINDS: readonly RecordKind[];
export const OUTCOME_STATUSES: readonly OutcomeStatus[];
export const CORRECTION_CLASSES: readonly CorrectionClass[];
export const LESSON_STATUSES: readonly LessonStatus[];
export const EVIDENCE_DEGREES: readonly EvidenceDegree[];
export const EVIDENCE_KINDS: readonly EvidenceKind[];
export const PROVENANCE_KINDS: readonly ProvenanceKind[];
export const ERASURE_MODES: readonly ['delete', 'anonymise'];

export function createMongoConscienceStore(db: import('./governor').MongoDatabase, options?: { prefix?: string }): ConscienceStore;
export function mongoConscienceIndexes(db: import('./governor').MongoDatabase, options?: { prefix?: string }): Promise<void>;
