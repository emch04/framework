/** Deterministic governor: no language model is imported or consulted. */

export type ProtectedScope = 'permissions' | 'budgets' | 'security' | 'privacy' | 'constitution' | 'approvals' | 'isolation' | 'governor';
export type ModifiableKind = 'instructions' | 'threshold' | 'tool_description' | 'routing';
export type ProposalStatus = 'rejected' | 'pending_approval' | 'approved' | 'declined';
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
}

export interface ChangeProposal {
  id: string; organisationId: string;
  target: { kind: string | null; id: string | null; version: string | null; organisationId: string | null } | null;
  change: unknown; justification: string | null; scopes: string[]; organisationIds: string[];
  proposedBy: Actor | null; owner: string | null; tests: unknown; replay: unknown; rollback: unknown;
  fingerprint: string; status: ProposalStatus; reasons: GovernorReason[];
  /** Constitution rules touched (ids). */
  rules: string[];
  policyVersion: string; createdAt: string; decidedAt: string | null; approver: HumanActor | null; note: string | null;
}

export interface AuditEntry {
  id: string; at: string; policyVersion: string; organisationId: string | null; proposalId: string | null;
  action: 'evaluate' | 'approve' | 'decline' | 'halt' | 'resume' | 'spend' | 'spend_refused';
  decision: string; reasons: string[]; actor: Actor | null; [key: string]: unknown;
}

export interface SpendInput { id: string; organisationId: string; agentId: string; cycleId?: string | null; cost: number }
export interface SpendTotals { cycle: number; agent: number; organisation: number }
export interface SpendDecision { allowed: boolean; reasons: GovernorReason[]; totals: SpendTotals | null; limits: { perCycle: number; perAgent: number; perOrganisation: number; since: number } }
export interface HaltState { halted: boolean; by: Actor; reason: string | null; at: string }

/** Storage of the governor. Implement it to use another database (see README). */
export interface GovernorStore {
  /** Insert once; an existing (organisationId, id) is returned unchanged with created: false. */
  putProposal(record: ChangeProposal): Promise<{ record: ChangeProposal; created: boolean }>;
  getProposal(organisationId: string, id: string): Promise<ChangeProposal | null>;
  /** Compare-and-set on status: returns null when the proposal is not in `fromStatus`. */
  transitionProposal(organisationId: string, id: string, fromStatus: ProposalStatus, patch: Partial<ChangeProposal>): Promise<ChangeProposal | null>;
  listProposals(filter: { organisationId: string; status?: ProposalStatus; limit?: number }): Promise<ChangeProposal[]>;
  appendAudit(entry: AuditEntry): Promise<AuditEntry>;
  /** Newest first. organisationId: null lists global entries (kill switch). */
  listAudit(filter: { organisationId?: string | null; proposalId?: string; limit?: number }): Promise<AuditEntry[]>;
  /** Atomic check-and-insert, idempotent by (organisationId, id). */
  reserveSpend(entry: { id: string; organisationId: string; agentId: string; cycleId: string | null; cost: number; at: number }, limits: { perCycle: number; perAgent: number; perOrganisation: number; since: number }): Promise<{ reserved: boolean; created: boolean; totals: SpendTotals }>;
  getControl(key: string): Promise<any | null>;
  setControl(key: string, value: unknown): Promise<unknown>;
}

export interface GovernorOptions {
  /** Default: memory store (lost on exit). */
  store?: GovernorStore;
  now?(): number;
  idFactory?(): string;
  /** Called after each audit entry; errors are ignored. */
  onEvent?(event: AuditEntry & { type: 'governor' }): void | Promise<void>;
}

export interface Governor {
  getPolicy(): GovernorPolicy;
  /** Judges a proposal by code. Never applies anything: at best it waits for human approval. */
  evaluatePolicy(proposal: ChangeProposalInput): Promise<ChangeProposal>;
  /** Approver: a human identity supplied by your application, never a model. Approval does not apply the change. */
  approveProposal(id: string, options: { approver: HumanActor; organisationId: string; note?: string }): Promise<ChangeProposal>;
  declineProposal(id: string, options: { approver: HumanActor; organisationId: string; note?: string }): Promise<ChangeProposal>;
  getProposal(organisationId: string, id: string): Promise<ChangeProposal | null>;
  listProposals(filter: { organisationId: string; status?: ProposalStatus; limit?: number }): Promise<ChangeProposal[]>;
  listAudit(filter?: { organisationId?: string | null; proposalId?: string; limit?: number }): Promise<AuditEntry[]>;
  authorizeSpend(input: SpendInput): Promise<SpendDecision>;
  /** Returns the single organisation of an operation, or throws (cross_organisation, organisation_required). */
  assertSingleOrganisation(...organisationIds: Array<string | null | undefined | Array<string | null | undefined>>): string;
  /** Kill switch. Any actor may pull it; global without organisationId. */
  halt(options: { by: Actor; reason?: string; organisationId?: string }): Promise<HaltState>;
  /** Only a human releases it. */
  resume(options: { by: HumanActor; reason?: string; organisationId?: string }): Promise<HaltState>;
  isHalted(organisationId?: string): Promise<boolean>;
  assertReady(options?: { organisationId?: string }): Promise<true>;
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
    | 'self_approval' | 'not_found' | 'not_pending' | 'protected_scope' | 'invalid_spend' | 'actor_required' | string;
  constructor(code: string, message: string);
}

export const PROPOSAL_STATUSES: readonly ProposalStatus[];
export const REASONS: Readonly<{ HALTED: 'governor_halted'; INVALID: 'invalid_proposal'; CROSS_ORGANISATION: 'cross_organisation'; PROTECTED: 'protected_scope'; NOT_ALLOWLISTED: 'not_allowlisted'; HUMAN_APPROVAL: 'human_approval_required'; BUDGET: 'budget_exceeded' }>;
export const PROTECTED_SCOPES: readonly ProtectedScope[];
export const MODIFIABLE_KINDS: readonly ModifiableKind[];
export const AUTOMATIC_CHANGES: readonly ['none'];
export const DEFAULT_CONSTITUTION: readonly ConstitutionRule[];
