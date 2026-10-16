/** Deterministic governor: no language model is imported or consulted. */

export type ProtectedScope = 'permissions' | 'budgets' | 'security' | 'privacy' | 'constitution' | 'approvals' | 'isolation' | 'governor';
export type ModifiableKind = 'instructions' | 'threshold' | 'tool_description' | 'routing';
export type ProposalStatus = 'rejected' | 'pending_approval' | 'approved' | 'declined' | 'expired';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type DeclineReason = 'insufficient_evidence' | 'risk_too_high' | 'not_needed' | 'wrong_scope' | 'poor_tests' | 'no_rollback_plan' | 'conflicts_with_policy' | 'bad_timing' | 'duplicate' | 'other' | (string & {});
export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type GovernorReason = 'governor_halted' | 'invalid_proposal' | 'cross_organisation' | 'protected_scope' | 'not_allowlisted' | 'human_approval_required' | 'budget_exceeded';

/** A protected rule: reflection may never change what it covers. `protectedScope` is a scope name, `kind:id`, or a prefix ending in `*`. */
export interface ConstitutionRule { id: string; description: string; protectedScope: string; owner: string }

export interface GovernorPolicyInput {
  version?: string;
  /** Spending caps, in your own cost unit. periodMs (default one day) is the window of perAgent and perOrganisation. */
  budgets: { perCycle: number; perAgent: number; perOrganisation: number; periodMs?: number };
  /** Added to the default constitution, which can never be removed. */
  constitution?: ConstitutionRule[];
  /** Objects a proposal may target; a subset of the four modifiable kinds. */
  permissions?: { modifiable?: ModifiableKind[] };
  /** Only 'none' in this version: every proposal waits for a human. */
  automaticChanges?: 'none';
  isolation?: 'organisation';
  /** Human identities allowed to approve; any human when absent. */
  approvers?: string[];
  /** Static kill switch: true keeps the governor halted until the policy changes. */
  halted?: boolean;
  /** Approval matrix, double approval, expiry and the register of decline reasons. */
  approvals?: ApprovalsPolicyInput;
}

export interface ApprovalsPolicyInput {
  /** Roles of each human identity. Required when the matrix names roles. */
  roles?: Record<string, string[]>;
  /** Who may approve a kind of change (or "default"), and how many approvals it needs at least. */
  matrix?: Partial<Record<ModifiableKind | 'default', { roles?: string[]; approvals?: number }>>;
  /** Minimum risk of a kind of change (default "medium" for all). A proposer can raise the risk, never lower it. */
  floors?: Partial<Record<ModifiableKind, RiskLevel>>;
  /** From this risk, two distinct people must approve (default "high"). */
  doubleApprovalFrom?: RiskLevel;
  /** With a double approval, the approvals must come from two different roles. */
  distinctRoles?: boolean;
  /** How long an approval stays valid, in milliseconds (default 7 days). */
  expiresInMs?: number;
  /** Extra codes added to the register of decline reasons. */
  declineReasons?: string[];
}

export interface ApprovalsPolicy {
  roles: Record<string, string[]> | null;
  matrix: Partial<Record<ModifiableKind | 'default', { roles: string[] | null; approvals: number }>>;
  floors: Record<string, RiskLevel>;
  doubleApprovalFrom: RiskLevel; distinctRoles: boolean; expiresInMs: number; declineReasons: string[];
}

export interface GovernorPolicy {
  version: string;
  budgets: { perCycle: number; perAgent: number; perOrganisation: number; periodMs: number };
  constitution: ConstitutionRule[];
  permissions: { modifiable: ModifiableKind[] };
  automaticChanges: 'none';
  isolation: 'organisation';
  approvers: string[] | null;
  halted: boolean;
  approvals: ApprovalsPolicy;
}

export interface Actor { kind: string; id: string }
export interface HumanActor { kind: 'human'; id: string }

export interface ChangeProposalInput {
  /** Stable id; derived from the content when absent (the same proposal twice is one record). */
  id?: string;
  organisationId: string;
  target: { kind: string; id: string; version?: string; organisationId?: string };
  change: unknown;
  justification?: string;
  /** Scopes the proposal declares it touches. */
  scopes?: string[];
  /** Other organisations touched: any makes the proposal cross-organisation. */
  organisationIds?: string[];
  proposedBy: { kind: 'engine' | 'model' | 'human' | 'system'; id: string };
  owner?: string;
  tests?: unknown;
  replay?: unknown;
  rollback?: unknown;
  /** Risk you declare; it can only raise the floor of the kind. */
  risk?: RiskLevel;
}

export interface ApprovalRecord { approver: HumanActor; role: string | null; at: string; expiresAt: string; note: string | null }

export interface ChangeProposal {
  id: string; organisationId: string;
  target: { kind: string | null; id: string | null; version: string | null; organisationId: string | null } | null;
  change: unknown; justification: string | null; scopes: string[]; organisationIds: string[];
  proposedBy: Actor | null; owner: string | null; tests: unknown; replay: unknown; rollback: unknown;
  fingerprint: string; status: ProposalStatus; reasons: GovernorReason[];
  /** Constitution rules touched (ids). */
  rules: string[];
  policyVersion: string; createdAt: string; decidedAt: string | null; approver: HumanActor | null; note: string | null;
  /** Effective risk: the higher of the floor of the kind and the declared risk. */
  risk: RiskLevel; declaredRisk: RiskLevel | null; requiredApprovals: number;
  /** Valid approvals recorded so far (one is enough below the double-approval risk). */
  approvals: ApprovalRecord[];
  declineReason: DeclineReason | null;
  /** Set once a candidate version was created from this proposal. */
  staged?: { versionId: string; at: string; by: Actor };
}

export interface AuditEntry {
  id: string; at: string; policyVersion: string; organisationId: string | null; proposalId: string | null;
  action: 'evaluate' | 'approve' | 'decline' | 'approval_expired' | 'expire' | 'halt' | 'resume' | 'spend' | 'spend_refused' | 'register' | 'stage' | 'deploy' | 'promote' | 'rollback' | 'emergency_revert' | 'finding' | ToolAuditAction;
  decision: string; reasons: string[]; actor: Actor | null; [key: string]: unknown;
}

export interface SpendInput { id: string; organisationId: string; agentId: string; cycleId?: string | null; cost: number }
export interface SpendTotals { cycle: number; agent: number; organisation: number }
export interface SpendDecision { allowed: boolean; reasons: GovernorReason[]; totals: SpendTotals | null; limits: { perCycle: number; perAgent: number; perOrganisation: number; since: number } }
export interface HaltState { halted: boolean; by: Actor; reason: string | null; at: string }

export type ManagedKind = ModifiableKind;
export interface ObjectRef { organisationId: string; kind: ManagedKind; id: string }
export interface Exposure { percentage: number; cohorts: string[] }
export interface ObjectState extends ObjectRef {
  revision: number;
  /** The version served to everyone outside the rollout. */
  stable: string;
  /** Stable versions in order, the last one being `stable`: rollback walks back along it. */
  stableHistory: string[];
  candidate: string | null;
  rollout: (Exposure & { startedAt: string; updatedAt: string; updatedBy: Actor }) | null;
  nextNumber: number; createdAt: string; updatedAt: string;
}
export interface ObjectVersion extends ObjectRef {
  versionId: string; number: number; content: unknown; fingerprint: string; parent: string | null;
  source: 'baseline' | 'proposal'; proposalId: string | null; createdAt: string; createdBy: Actor;
  approvedBy?: Array<{ id: string; role: string | null; at: string }>;
}
export interface ObjectVersionView extends ObjectVersion { status: 'stable' | 'candidate' | 'previous' | 'discarded' }
export interface ResolvedVersion { versionId: string; number: number; content: unknown; source: 'stable' | 'candidate'; reason: 'no_candidate' | 'halted' | 'not_in_rollout' | 'in_rollout' }
export interface RollbackResult { object: ObjectState; mode: 'candidate_discarded' | 'stable_restored'; discardedVersion: string; restoredVersion: string }
/** Rules in the shape of @astratra/flags (createMemorySource): one boolean flag per object that has a candidate. */
export interface ExportedFlagRules { flags: Record<string, { type: 'boolean'; default: false; value: true; rollout: number; seed: string; target?: { cohort: string[] } }> }
/** The part of an @astratra/flags FlagProvider the governor uses. Nothing is imported from that package. */
export interface FlagResolver { resolveBoolean(key: string, fallback?: boolean, context?: { targetingKey?: string; attributes?: Record<string, unknown> }): Promise<{ value: boolean }> }

export interface FindingInput {
  id?: string; organisationId: string; runId?: string; code: string; severity: FindingSeverity;
  subject: { kind: string; id: string }; decisionIds?: string[]; evidenceRefs?: string[]; sampleSize?: number; confidence?: number;
  metrics?: unknown; recordedBy: Actor;
}
export interface Finding extends Required<Pick<FindingInput, 'organisationId' | 'code' | 'severity' | 'subject' | 'recordedBy'>> {
  id: string; runId: string | null; decisionIds: string[]; evidenceRefs: string[]; sampleSize: number | null; confidence: number | null; metrics: unknown; receivedAt: string;
}

/** A refusal, human or by code, as a signal for the evaluation and experiment phases. Codes only. */
export interface RejectionSignal {
  proposalId: string; organisationId: string; origin: 'human' | 'governor'; reasonCodes: string[];
  target: { kind: string | null; id: string | null; version: string | null }; risk: RiskLevel | null; scopes: string[]; rules: string[];
  proposedBy: Actor | null; decidedBy: HumanActor | null; at: string;
}

/** The morning report is data: ids, codes and numbers. An interface turns it into words. */
export interface MorningReport {
  schema: 'morning-report/1'; organisationId: string; policyVersion: string; since: string; until: string; halted: boolean;
  findings: { total: number; bySeverity: Record<FindingSeverity, number>; items: Finding[] };
  pendingProposals: Array<{
    id: string; target: { kind: string | null; id: string | null; version: string | null }; risk: RiskLevel; requiredApprovals: number; approvalsValid: number;
    approvedBy: Array<{ id: string; role: string | null; at: string; expiresAt: string }>; allowedRoles: string[] | null; scopes: string[]; proposedBy: Actor | null;
    owner: string | null; createdAt: string; hasJustification: boolean; hasTests: boolean; tests: unknown; hasReplay: boolean; hasRollbackPlan: boolean; rollbackPlan: unknown;
  }>;
  approvedAwaitingStage: Array<{ id: string; target: { kind: string | null; id: string | null; version: string | null }; risk: RiskLevel; approvedAt: string | null; expiresAt: string | null; valid: boolean; expired: boolean; approvalsValid: number }>;
  rollouts: Array<{ kind: string; id: string; stableVersion: string; candidateVersion: string | null; proposalId: string | null; percentage: number; cohorts: string[]; startedAt: string | null; updatedAt: string | null }>;
  rejections: RejectionSignal[];
  rollbacks: Array<{ at: string; kind: string; id: string; fromVersion: string; toVersion: string; mode: string; emergency: boolean; reason: string | null; actor: Actor | null }>;
  counts: { findings: number; pending: number; pendingHighRisk: number; approvedAwaitingStage: number; rollouts: number; rejections: number; humanRejections: number; rollbacks: number };
}

export interface ApprovalInvariantReport { ok: boolean; checked: { proposals: number; versions: number }; violations: Array<{ type: 'proposal' | 'version'; code: string; proposalId?: string | null; versionId?: string; kind?: string; id?: string }> }

/** Storage of the governor. Implement it to use another database (see README). */
export interface GovernorStore {
  /** Insert once; an existing (organisationId, id) is returned unchanged with created: false. */
  putProposal(record: ChangeProposal): Promise<{ record: ChangeProposal; created: boolean }>;
  getProposal(organisationId: string, id: string): Promise<ChangeProposal | null>;
  /** Compare-and-set on status: returns null when the proposal is not in `fromStatus`. */
  transitionProposal(organisationId: string, id: string, fromStatus: ProposalStatus, patch: Partial<ChangeProposal>, guard?: { approvals: number }): Promise<ChangeProposal | null>;
  listProposals(filter: { organisationId: string; status?: ProposalStatus; statuses?: ProposalStatus[]; /** Decided (or, when pending, created) at or after this ISO date. */ since?: string; limit?: number }): Promise<ChangeProposal[]>;
  appendAudit(entry: AuditEntry): Promise<AuditEntry>;
  /** Newest first. organisationId: null lists global entries (kill switch). */
  listAudit(filter: { organisationId?: string | null; proposalId?: string; actions?: string[]; since?: string; objectKind?: string; objectId?: string; limit?: number }): Promise<AuditEntry[]>;
  /** Atomic check-and-insert, idempotent by (organisationId, id). */
  reserveSpend(entry: { id: string; organisationId: string; agentId: string; cycleId: string | null; cost: number; at: number }, limits: { perCycle: number; perAgent: number; perOrganisation: number; since: number }): Promise<{ reserved: boolean; created: boolean; totals: SpendTotals }>;
  getControl(key: string): Promise<any | null>;
  setControl(key: string, value: unknown): Promise<unknown>;
  /** Versioned objects. */
  getObject(organisationId: string, kind: string, id: string): Promise<ObjectState | null>;
  createObject(state: ObjectState): Promise<{ record: ObjectState; created: boolean }>;
  /** Compare-and-set on `revision`: null when another writer got there first. */
  updateObject(organisationId: string, kind: string, id: string, expectedRevision: number, next: ObjectState): Promise<ObjectState | null>;
  listObjects(filter: { organisationId?: string; kind?: string; hasCandidate?: boolean; limit?: number }): Promise<ObjectState[]>;
  putVersion(record: ObjectVersion): Promise<{ record: ObjectVersion; created: boolean }>;
  getVersion(organisationId: string, kind: string, id: string, versionId: string): Promise<ObjectVersion | null>;
  /** Oldest first. */
  listVersions(filter: ObjectRef & { limit?: number }): Promise<ObjectVersion[]>;
  putFinding(record: Finding): Promise<{ record: Finding; created: boolean }>;
  listFindings(filter: { organisationId: string; since?: string; until?: string; limit?: number }): Promise<Finding[]>;
}

export interface GovernorOptions {
  /** Default: memory store (lost on exit). */
  store?: GovernorStore;
  now?(): number;
  idFactory?(): string;
  /** Called after each audit entry; errors are ignored. */
  onEvent?(event: AuditEntry & { type: 'governor' }): void | Promise<void>;
  /** An @astratra/flags FlagProvider (or anything with resolveBoolean): it then decides who sees a candidate. Absent: built-in rollout with the same hashing. */
  flags?: FlagResolver;
}

export interface Governor {
  getPolicy(): GovernorPolicy;
  /** Judges a proposal by code. Never applies anything: at best it waits for human approval. */
  evaluatePolicy(proposal: ChangeProposalInput): Promise<ChangeProposal>;
  /** Approver: a human identity supplied by your application, never a model. Approval does not apply the change. */
  approveProposal(id: string, options: { approver: HumanActor; organisationId: string; note?: string; /** Role to act under, when the person holds several. */ role?: string }): Promise<ChangeProposal>;
  /** reasonCode comes from the register (DECLINE_REASONS plus the policy's own codes). */
  declineProposal(id: string, options: { approver: HumanActor; organisationId: string; reasonCode: DeclineReason; note?: string }): Promise<ChangeProposal>;
  /** Moves approved proposals whose approvals ran out, and that nobody staged, to "expired". Returns their ids. */
  expireApprovals(options: { organisationId: string; by?: Actor }): Promise<string[]>;
  getProposal(organisationId: string, id: string): Promise<ChangeProposal | null>;
  listProposals(filter: { organisationId: string; status?: ProposalStatus; limit?: number }): Promise<ChangeProposal[]>;
  listAudit(filter?: { organisationId?: string | null; proposalId?: string; limit?: number }): Promise<AuditEntry[]>;
  authorizeSpend(input: SpendInput): Promise<SpendDecision>;
  /** Returns the single organisation of an operation, or throws (cross_organisation, organisation_required). */
  assertSingleOrganisation(...organisationIds: Array<string | null | undefined | Array<string | null | undefined>>): string;
  /** Kill switch. Any actor may pull it; global without organisationId. */
  halt(options: { by: Actor; reason?: string; organisationId?: string }): Promise<HaltState & { reverted: Array<ObjectRef & { discardedVersion: string; restoredVersion: string }>; failures: Array<ObjectRef & { code: string }> }>;
  /** Only a human releases it. */
  resume(options: { by: HumanActor; reason?: string; organisationId?: string }): Promise<HaltState>;
  isHalted(organisationId?: string): Promise<boolean>;
  assertReady(options?: { organisationId?: string }): Promise<true>;

  /** Declares the version in use today (version v1) of an object. Human or system only. */
  registerObject(input: ObjectRef & { content: unknown; by: HumanActor | { kind: 'system'; id: string } }): Promise<{ object: ObjectState; version: ObjectVersion; created: boolean }>;
  /** Creates the candidate version (0 % exposure) of an approved proposal. Never for a model's say-so: the approvals are re-checked. */
  stageChange(proposalId: string, input: { organisationId: string; by: Actor }): Promise<{ object: ObjectState; version: ObjectVersion; created: boolean }>;
  /** Sets the exposure of the candidate: percentage 0 to 100 and/or cohorts. A human only. */
  deployChange(input: ObjectRef & { percentage?: number; cohorts?: string[]; by: HumanActor }): Promise<ObjectState>;
  /** Makes the candidate stable once it reaches 100 % of everyone. A human only. */
  promoteChange(input: ObjectRef & { by: HumanActor }): Promise<ObjectState>;
  /** Discards the candidate, or restores the version that was stable before the last promotion. Any identified actor, any time. */
  rollbackChange(input: ObjectRef & { by: Actor; reason?: string }): Promise<RollbackResult>;
  /** Which version this caller gets. Halted or outside the rollout: the stable one. */
  resolveVersion(input: ObjectRef & { targetingKey?: string; attributes?: Record<string, unknown> }): Promise<ResolvedVersion>;
  getObject(input: ObjectRef): Promise<ObjectState | null>;
  listObjects(input: { organisationId: string; kind?: ManagedKind; hasCandidate?: boolean; limit?: number }): Promise<ObjectState[]>;
  listVersions(input: ObjectRef & { limit?: number }): Promise<ObjectVersionView[]>;
  /** Audit entries of one object, newest first: who, what, when, version before and after. */
  getChangeHistory(input: ObjectRef & { limit?: number }): Promise<AuditEntry[]>;
  exportFlagRules(input: { organisationId: string }): Promise<ExportedFlagRules>;

  recordFinding(input: FindingInput): Promise<Finding>;
  listFindings(input: { organisationId: string; since?: Date | string | number; limit?: number }): Promise<Finding[]>;
  listRejectionSignals(input: { organisationId: string; since?: Date | string | number; origin?: 'human' | 'governor'; reasonCode?: string; targetKind?: string; limit?: number }): Promise<RejectionSignal[]>;
  morningReport(input: { organisationId: string; since: Date | string | number; until?: Date | string | number; limit?: number }): Promise<MorningReport>;
  /** Checks that no stored approval or version rests on anything but human approvals. */
  verifyApprovalInvariant(input: { organisationId: string }): Promise<ApprovalInvariantReport>;
}

export function createGovernor(policy: GovernorPolicyInput, options?: GovernorOptions): Governor;
/** Bootstrap check before any reflective write: governor_missing, governor_invalid, governor_unavailable, governor_halted. */
export function assertGovernorReady(governor: Governor | null | undefined, options?: { organisationId?: string }): Promise<true>;
export function isGovernor(value: unknown): value is Governor;
export function validatePolicy(policy: GovernorPolicyInput | null | undefined): GovernorPolicy;
export function scopesOf(proposal: Partial<ChangeProposalInput>): Set<string>;
export function protectedRulesTouched(policy: GovernorPolicy, proposal: Partial<ChangeProposalInput>): string[];
export function createMemoryGovernorStore(): GovernorStore;
export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>; connect?(): Promise<any> }
export function createPostgresGovernorStore(db: Queryable, options?: { prefix?: string }): GovernorStore;
export function postgresGovernorSchema(options?: { prefix?: string }): string;

export class GovernorError extends Error {
  code: 'policy_missing' | 'policy_invalid' | 'governor_missing' | 'governor_invalid' | 'governor_unavailable' | 'governor_halted'
    | 'organisation_required' | 'cross_organisation' | 'invalid_proposal' | 'proposal_conflict' | 'approver_not_human' | 'approver_not_allowed'
    | 'self_approval' | 'not_found' | 'not_pending' | 'protected_scope' | 'invalid_spend' | 'actor_required'
    | 'not_approved' | 'approval_expired' | 'approval_insufficient' | 'approval_invalid' | 'approver_role_missing' | 'approval_roles_not_distinct' | 'already_approved' | 'decline_reason_required'
    | 'proposal_tampered' | 'already_staged' | 'candidate_exists' | 'stale_base' | 'change_conflict' | 'no_candidate' | 'rollout_incomplete' | 'invalid_rollout'
    | 'nothing_to_rollback' | 'object_exists' | 'invalid_object' | 'invalid_finding' | 'invalid_period' | 'actor_not_allowed' | 'invalid_settings' | string;
  constructor(code: string, message: string);
}

export const PROPOSAL_STATUSES: readonly ProposalStatus[];
export const REASONS: Readonly<{ HALTED: 'governor_halted'; INVALID: 'invalid_proposal'; CROSS_ORGANISATION: 'cross_organisation'; PROTECTED: 'protected_scope'; NOT_ALLOWLISTED: 'not_allowlisted'; HUMAN_APPROVAL: 'human_approval_required'; BUDGET: 'budget_exceeded' }>;
export const PROTECTED_SCOPES: readonly ProtectedScope[];
export const MODIFIABLE_KINDS: readonly ModifiableKind[];
export const AUTOMATIC_CHANGES: readonly ['none'];
export const DEFAULT_CONSTITUTION: readonly ConstitutionRule[];

export const RISK_LEVELS: readonly RiskLevel[];
/** The register of reasons a person can give when declining. */
export const DECLINE_REASONS: readonly DeclineReason[];
export const FINDING_SEVERITIES: readonly FindingSeverity[];
export const MORNING_REPORT_SCHEMA: 'morning-report/1';
/** The bucket (0 to 1) of an identifier, identical to bucket() of @astratra/flags. */
export function rolloutBucket(seed: string, identifier: string | null | undefined): number | null;

/* ---------- Remote settings (a dashboard turns the agent on, halts it, names approvers, decides) ---------- */

/** Remote settings as a dashboard sends them (schema "conscience-settings/1"). Unknown fields are ignored, never applied. */
export interface RemoteSettingsInput {
  schema?: 'conscience-settings/1';
  version?: number;
  enabled: boolean;
  halted: boolean;
  /** Human identity who released the kill switch: the only one allowed to resume a halt pulled remotely. */
  resumedBy?: string | null;
  approvers?: string[];
  reflection?: { automatic: boolean; hour: number; timeZone?: string };
  cyclesPerDay?: number;
  [field: string]: unknown;
}
export interface RemoteSettings {
  version: number; enabled: boolean; halted: boolean; resumedBy: string | null; approvers: readonly string[];
  reflection: { automatic: boolean; hour: number; timeZone: string }; cyclesPerDay: number;
  /** Fields of the answer that were not applied (constitution, budgets, permissions… are never taken from a remote source). */
  ignored: readonly string[];
}
export interface RemoteSettingsState {
  /** remote: the last read succeeded; last_known: the source is silent or invalid, the last valid settings stay; none: nothing valid ever seen (all off). */
  source: 'remote' | 'last_known' | 'none';
  known: boolean; version: number | null; fetchedAt: string | null;
  error: 'source_unavailable' | 'invalid_settings' | 'stale_settings' | null;
  enabled: boolean; halted: boolean; resumedBy: string | null; approvers: string[];
  reflection: { automatic: boolean; hour: number; timeZone: string }; cyclesPerDay: number; ignored: string[];
}
/** A human decision taken on the dashboard. */
export interface RemoteDecision { id: string; proposalId: string; decision: 'approve' | 'decline'; approver: HumanActor; reasonCode?: string | null; [field: string]: unknown }
export interface RemoteDecisionResult {
  id: string | null; proposalId: string | null;
  /** failed: the governor could not be reached, try again later (do not acknowledge). */
  result: 'applied' | 'already_applied' | 'refused' | 'failed';
  code: string | null;
}
export interface RemoteSettingsOptions {
  /** Returns the remote settings (e.g. a dashboard client with its own cache). May throw: the last valid settings then stay. */
  read(): Promise<RemoteSettingsInput | unknown> | RemoteSettingsInput | unknown;
  /** The local policy: constitution, permissions, approval matrix, and budget CEILINGS. Remote settings only narrow it. */
  policy: GovernorPolicyInput;
  organisationId: string;
  /** Budget units of one reflection cycle (default 1): perAgent and perOrganisation become min(local, cyclesPerDay × costPerCycle). */
  costPerCycle?: number;
  /** Keeps the last valid settings across restarts. */
  storage?: { load(): unknown | Promise<unknown>; save(snapshot: { settings: unknown; fetchedAt: string | null }): void | Promise<void> };
  now?(): number;
  /** Who pulls the kill switch in the governor's journal (default { kind: 'system', id: 'remote-settings' }). Never a human. */
  actor?: { kind: string; id: string };
  onEvent?(event: { type: 'remote_settings'; action: string; [key: string]: unknown }): void;
}
export interface RemoteSettingsController {
  /** Reads the source once; never throws. */
  refresh(): Promise<{ source: RemoteSettingsState['source']; changed: boolean; error: RemoteSettingsState['error'] }>;
  current(): RemoteSettingsState;
  /** The governor policy in force: local policy narrowed by the remote settings; halted when disabled, halted or unknown. */
  policy(): GovernorPolicyInput;
  /** The governor for the policy in force, rebuilt when it changes. Ask for it each time instead of keeping it. */
  governor(options?: GovernorOptions): Governor;
  /** Applies the remote kill switch to the governor's store now; resumes only a halt it pulled, and only by the human in resumedBy. */
  sync(governor: Governor): Promise<{ action: 'halt' | 'resume' | 'none'; halted: boolean; reason?: 'halted_by_another_actor' | 'resume_needs_human' }>;
  /** Submits human decisions through approveProposal / declineProposal. Replays come back as already_applied. */
  applyDecisions(governor: Governor, decisions: RemoteDecision[]): Promise<RemoteDecisionResult[]>;
  /** True during the configured local hour when the agent is enabled, not halted, with automatic reflection. */
  reflectionDue(at?: number): boolean;
  /** reflection_YYYY-MM-DD in the configured time zone: one idempotent cycle per local day. */
  reflectionCycleId(at?: number): string;
}
export function createRemoteSettings(options: RemoteSettingsOptions): RemoteSettingsController;
/** Validates remote settings; throws GovernorError invalid_settings. */
export function parseRemoteSettings(raw: unknown): RemoteSettings;
/** The local policy narrowed by remote settings (null: unknown, everything off). */
export function remotePolicy(localPolicy: GovernorPolicyInput, settings: RemoteSettings | null, options?: { costPerCycle?: number }): GovernorPolicyInput;
export const REMOTE_SETTINGS_SCHEMA: 'conscience-settings/1';
export const DECISION_RESULTS: readonly ['applied', 'already_applied', 'refused', 'failed'];

/** Native driver objects; pass connection.db and connection.getClient() with mongoose. */
export interface MongoDatabase { collection(name: string): any; client?: MongoSessionClient }
export interface MongoSessionClient { startSession(): any }
export interface MongoStoreOptions { prefix?: string; client?: MongoSessionClient }
/** Requires a replica set or sharded cluster for atomic spending. */
export function createMongoGovernorStore(db: MongoDatabase, options?: MongoStoreOptions): GovernorStore;
export function mongoGovernorIndexes(db: MongoDatabase, options?: { prefix?: string }): Promise<void>;

/* ---- Tool policy and calendar budget (generic: families, levels, caps and vocabulary are yours) ---- */

export type ToolAuditAction = 'tool_decision' | 'tool_outcome' | 'tool_halt' | 'tool_halt_denied' | 'tool_resume' | 'tool_resume_denied';
export const TOOL_LEVELS: { readonly READ: 'read'; readonly CONTROLLED: 'controlled'; readonly SENSITIVE: 'sensitive' };
export const TOOL_DECISIONS: { readonly ALLOWED: 'allowed'; readonly PENDING: 'pending'; readonly REFUSED: 'refused' };
export const TOOL_REASONS: {
  readonly HALTED: 'emergency_stop'; readonly DISABLED: 'disabled'; readonly UNAVAILABLE: 'settings_unavailable'; readonly UNKNOWN_TOOL: 'unknown_tool';
  readonly FAMILY_DISABLED: 'family_disabled'; readonly INVALID_INPUT: 'invalid_input'; readonly BUDGET: 'budget_exceeded'; readonly CAP: 'cap_reached';
  readonly SENSITIVE: 'sensitive_tool'; readonly UNTRUSTED: 'untrusted_context'; readonly THRESHOLD: 'over_threshold';
};
export type ToolLevel = 'read' | 'controlled' | 'sensitive';
export type ToolDecisionWord = 'allowed' | 'pending' | 'refused';
export type ToolReasonCode = typeof TOOL_REASONS[keyof typeof TOOL_REASONS];

/** An actor of a tool call or of the kill switch. `roles` are checked against emergency.activateRoles / releaseRoles. */
export interface ToolActor { kind: string; id: string; roles?: string[] }

export interface ToolDefinition {
  /** Letters, digits, _ . : - ; starts with a letter. */
  name: string;
  family: string;
  /** One of the level words (the canonical ones, or yours when labels.levels renames them). */
  level: string;
  /** Returns false, { ok: false }, or { ok: true, value } (the value replaces the input). May throw: invalid. */
  validate?(input: any): boolean | { ok: boolean; value?: unknown };
  /** Controlled tools only: true sends the call to a person (an amount over your own threshold, for instance). Throwing counts as true. */
  overThreshold?(input: any, settings: ToolSettings): boolean;
  /** At most this many calls of the tool in one run; the next ones are refused (cap_reached). */
  maxPerRun?: number;
  /** Whole units this call is expected to consume: refused up front when it cannot fit in the budget. */
  estimatedCost?: number;
  /** Stays callable when the budget is exhausted (read-only state, for instance). */
  budgetExempt?: boolean;
}

/** Settings read before EACH call; anything else you put in is handed back to your validate and overThreshold functions. */
export interface ToolSettings {
  /** false: every call is refused (disabled). */
  enabled?: boolean;
  /** family -> on/off. A family that is not listed is on. */
  families?: Record<string, boolean>;
  /** Cap of the calendar budget, whole units. Overrides the default limit of the budget. */
  budgetLimit?: number | null;
  /** Calls of all tools in one run. */
  maxCallsPerRun?: number | null;
  [key: string]: unknown;
}

export interface ToolRun { calls: number; byTool: Record<string, number>; untrusted: boolean; /** Call after the run read content from outside (a web page, a file...). */ markUntrusted(): void }

export interface ToolCall {
  tool: string;
  input?: unknown;
  /** The counters of the run (createRun()). Without it each call is a run of its own. */
  run?: ToolRun;
  actor?: ToolActor | null;
  organisationId?: string | null;
  /** The caller flags this call as made in an untrusted context. */
  untrusted?: boolean;
  /** Budget scope; defaults to organisationId, then "default". */
  budgetScope?: string;
  /** execute() only: the caller's own abort signal. */
  signal?: AbortSignal;
}

export interface ToolDecision {
  allowed: boolean;
  /** 'allowed' | 'pending' | 'refused', or your word. */
  decision: string;
  /** Why it is not allowed (a TOOL_REASONS value, or your word); null when allowed. */
  code: string | null;
  reasons: string[];
  tool: string; family: string | null; level: string | null;
  /** The input after validate(). */
  input: unknown;
  budget: BudgetStanding | null;
  /** Rank of this call in its run. */
  rank: number;
  /** Id of the audit record of this decision. */
  auditId: string;
}
export interface ToolExecution<T = unknown> extends ToolDecision { executed: boolean; interrupted: boolean; result?: T }

export interface ToolPolicyOptions {
  tools: ToolDefinition[];
  /** When given, every tool's family must be in the list. */
  families?: string[];
  /** Static settings under what settings() returns. */
  defaults?: ToolSettings;
  /** Read before every call. May throw: the call is refused (settings_unavailable). */
  settings?(context: { organisationId: string | null; actor: ToolActor | null }): ToolSettings | Promise<ToolSettings>;
  /** A calendar budget (createCalendarBudget) or its options. */
  budget?: CalendarBudget | CalendarBudgetOptions;
  /** Levels whose calls wait for a person after an untrusted read (default: only the controlled level). */
  untrustedPendingLevels?: string[];
  emergency?: {
    /** Roles allowed to pull the kill switch (default: any actor with an id). */
    activateRoles?: string[];
    /** Roles allowed to release it (default: any human). A model or an engine never can. */
    releaseRoles?: string[];
  };
  /** Rename the words you get back: canonical word -> your word. Tools declare their level in your word. */
  labels?: { levels?: Partial<Record<ToolLevel, string>>; decisions?: Partial<Record<ToolDecisionWord, string>>; codes?: Partial<Record<ToolReasonCode, string>> };
  /** Audit journal and kill switch keys (default: memory). Use the store of your governor. */
  store?: Pick<GovernorStore, 'appendAudit' | 'listAudit' | 'getControl' | 'setControl'>;
  /** A governor whose kill switch also stops the tools. */
  governor?: Governor;
  version?: string;
  /** How often a running tool looks at the kill switch pulled by another process (default 1000, 0 = off). */
  pollMs?: number;
  now?(): number;
  idFactory?(): string;
  onEvent?(event: { type: 'tool_policy' } & AuditEntry): void | Promise<void>;
}

export interface ToolPolicy {
  readonly version: string;
  createRun(): ToolRun;
  /** The decision for one call; audited. Throws only when the journal cannot be written. */
  decide(call: ToolCall): Promise<ToolDecision>;
  /** Decides, then runs fn only when allowed, and cuts it at once on an emergency stop (signal + abandon). */
  execute<T>(call: ToolCall, fn: (input: any, context: { signal: AbortSignal; decision: ToolDecision }) => T | Promise<T>): Promise<ToolExecution<Awaited<T>>>;
  /** Names of the tools to offer the model now (none when stopped or disabled). */
  availableTools(context?: { organisationId?: string | null }): Promise<string[]>;
  listTools(): Array<{ name: string; family: string; level: string; maxPerRun: number | null; estimatedCost: number; budgetExempt: boolean }>;
  halt(options: { by: ToolActor; reason?: string; organisationId?: string }): Promise<unknown>;
  resume(options: { by: ToolActor; organisationId?: string }): Promise<unknown>;
  isHalted(organisationId?: string | null): Promise<boolean>;
  /** Counts what a call really consumed (whole units, idempotent by id), in the period of `at` (default now). */
  recordSpend(spend: { id: string; amount: number; organisationId?: string; scope?: string; at?: number }): Promise<{ added: boolean; scope: string; period: string; spent: number }>;
  budgetStatus(query?: { organisationId?: string; scope?: string; at?: number; estimate?: number }): Promise<BudgetStanding>;
  listAudit: GovernorStore['listAudit'];
}
export function createToolPolicy(options: ToolPolicyOptions): ToolPolicy;

export interface BudgetStanding {
  /** false when the cap is reached (or the estimate does not fit). */
  allowed: boolean; exceeded: boolean; scope: string; period: string; spent: number; limit: number | null; remaining: number | null;
}
/** spent/limit/remaining are whole units of your choice (cents, thousandths of cents, tokens...). No fractions. */
export interface ToolBudgetStore {
  getSpent(scope: string, period: string): Promise<number>;
  /** Idempotent by (scope, id): a replay adds nothing and returns added: false. */
  addSpend(entry: { scope: string; period: string; id: string; amount: number; at: string }): Promise<{ added: boolean; spent: number }>;
}
export interface CalendarBudgetOptions {
  /** 'month' (default), 'day', or a function (instant, timeZone) => key. */
  period?: 'month' | 'day' | ((at: Date, timeZone: string) => string);
  /** IANA time zone (default UTC). */
  timeZone?: string;
  /** Default cap in whole units; absent: no cap. */
  limit?: number | null;
  scope?: string;
  store?: ToolBudgetStore;
  now?(): number;
}
export interface CalendarBudget {
  check(query?: { scope?: string; limit?: number | null; estimate?: number; at?: number | Date }): Promise<BudgetStanding>;
  record(spend: { id: string; amount: number; scope?: string; at?: number | Date }): Promise<{ added: boolean; scope: string; period: string; spent: number }>;
  periodKey(at?: number | Date): string;
  readonly period: string; readonly timeZone: string;
}
export function createCalendarBudget(options?: CalendarBudgetOptions): CalendarBudget;
/** "2026-10" (month) or "2026-10-31" (day) of an instant, in a time zone. */
export function calendarPeriodKey(at: number | Date, options?: { period?: CalendarBudgetOptions['period']; timeZone?: string }): string;
export function createMemoryToolBudgetStore(): ToolBudgetStore;
export function createPostgresToolBudgetStore(db: Queryable, options?: { prefix?: string }): ToolBudgetStore;
export function postgresToolBudgetSchema(options?: { prefix?: string }): string;
