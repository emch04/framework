import type { KeyObject } from 'node:crypto';

export type Level = 'free' | 'free_with_notice' | 'validation' | 'forbidden';
export type Operation = 'insert' | 'update' | 'delete';
export type Decision = 'approve' | 'decline' | 'undo';
export type Status = 'ready' | 'awaiting_validation' | 'executing' | 'executed' | 'declined' | 'expired' | 'refused' | 'stale' | 'failed' | 'undoing' | 'undone';
export type Scalar = string | number | boolean | null;

export declare const LEVELS: readonly Level[];
export declare const DEFAULT_LEVEL: 'validation';
export declare const OPERATIONS: readonly Operation[];
export declare const COMPARISONS: readonly string[];
export declare const DECISIONS: readonly Decision[];
export declare const STATUSES: readonly Status[];
export declare const MAX_ACTIONS: number;
export declare const PROPOSAL_SCHEMA: 'gouvernance-proposition/1';
export declare const VALIDATION_SCHEMA: 'gouvernance-validation/1';
export declare const CHALLENGE_SCHEMA: 'gouvernance-defi/1';
export declare const RESULT_SCHEMA: 'gouvernance-resultat/1';

export declare class GouvernanceError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export interface ResourceDeclaration {
  table: string;
  key: string | string[];
  writable?: string[];
  filterable?: string[];
  sensitive?: string[];
  tags?: string[];
  amount?: string;
  maxRows?: number;
  operations?: Operation[];
  /** Le type d'une colonne quand la base ne le déduit pas d'un texte (MongoDB). */
  types?: Record<string, 'objectId' | 'date'>;
}

export interface Resource {
  readonly name: string;
  readonly table: string;
  readonly key: readonly string[];
  readonly writable: readonly string[];
  readonly filterable: readonly string[];
  readonly readable: readonly string[];
  readonly sensitive: readonly string[];
  readonly tags: readonly string[];
  readonly amount: string | null;
  readonly maxRows: number;
  readonly operations: readonly Operation[];
  readonly types: Readonly<Record<string, 'objectId' | 'date'>>;
}

export type Condition = Scalar | { eq?: Scalar; ne?: Scalar; gt?: string | number; gte?: string | number; lt?: string | number; lte?: string | number; in?: Array<string | number | boolean>; isNull?: boolean };
export type SetValue = Scalar | { increment: number; round?: number } | { multiply: number; round?: number };

export interface Action {
  connector: string;
  resource: string;
  op: Operation;
  where?: Record<string, Condition>;
  set?: Record<string, SetValue>;
  values?: Record<string, Scalar>;
}

export interface Rule {
  id: string;
  level: Level;
  match?: {
    ops?: Operation[];
    resources?: string[];
    tags?: string[];
    agents?: string[];
    rowsAbove?: number;
    amountAbove?: number;
    when?: { timeZone?: string; days?: number[]; from?: string; to?: string };
  };
  approvals?: number;
  quota?: { perDay: number };
}

export interface Masked { $masked: string }

export interface PreviewRow {
  action: number;
  resource: string;
  op: Operation;
  key: Record<string, unknown>;
  before: Record<string, unknown | Masked> | null;
  after: Record<string, unknown | Masked> | null;
  version: string | null;
}

export interface Proposal {
  schema: 'gouvernance-proposition/1';
  id: string;
  organisationId: string;
  environment: string;
  createdAt: string;
  expiresAt: string;
  agent: { id: string; model: string | null; instructions: string | null };
  requestedBy: { kind: string; id: string } | null;
  intent: { code: string; confidence: number | null };
  idempotencyKey: string | null;
  actions: Action[];
  preview: { rows: PreviewRow[]; counts: { rows: number; actions: number; resources: number }; amount: number };
  classification: {
    groups: Array<{ resource: string; ops: Operation[]; tags: string[]; rows: number; amount: number }>;
    level: Level;
    approvals: number;
    rules: Array<{ id: string | null; origin: 'local' | 'remote' | 'default'; level: Level }>;
  };
  digest: string;
}

export interface Approval {
  approver: string;
  credentialId: string;
  nonce: string;
  at?: string;
  webauthn: { authenticatorData: string; clientDataJSON: string; signature: string };
}

export interface Validation {
  schema: 'gouvernance-validation/1';
  propositionId: string;
  digest: string;
  decision: Decision;
  environment: string;
  approvals: Approval[];
  issuedAt: string;
  expiresAt: string;
  keyId: string;
  signature: string;
}

export interface Result {
  schema: 'gouvernance-resultat/1';
  propositionId: string;
  status: 'executed' | 'stale' | 'failed';
  code: string | null;
  rowsAffected: number;
  at: string;
  detail: unknown;
}

export interface ProposalView {
  status: Status | null;
  code: string | null;
  level?: Level;
  reasons?: string[];
  proposal?: Proposal | null;
  explanation?: string | null;
  result?: Result | null;
  undo?: unknown;
}

export interface TrustInput {
  keys: Array<{ keyId: string; publicKey: string | KeyObject; notAfter?: string }>;
  approvers?: Array<{ id: string; subject?: string; credentials: Array<{ id: string; publicKey: string | KeyObject; rpId?: string; origins?: string[] }> }>;
  rpId?: string;
  origins?: string[];
  maxAgeMs?: number;
  skewMs?: number;
}
export interface Trust { readonly maxAgeMs: number; readonly skewMs: number }

export interface ExecutionStep {
  action: number;
  resource: string;
  op: Operation;
  select: { where: Record<string, Record<string, unknown>> } | { keys: Array<Record<string, unknown>> };
  expect: Array<{ key: Record<string, unknown>; version?: string; values?: Record<string, unknown>; before?: Record<string, unknown> }>;
  writes: Array<{ kind: 'update' | 'insert' | 'delete'; key: Record<string, unknown>; set?: Record<string, unknown>; values?: Record<string, unknown> }>;
}
export interface ExecutionPlan {
  steps: ExecutionStep[];
  compare(step: ExecutionStep, found: Array<Record<string, unknown>>): null | { action: number; reason: string };
}

export interface Connector {
  readonly kind: string;
  readonly resources: Readonly<Record<string, Resource>>;
  /** Une seule action par proposition. */
  readonly singleAction?: boolean;
  /** `false` : jamais d'annulation ni de niveau « libre avec avis ». */
  readonly undoable?: boolean;
  preview(action: Action, options: { limit: number }): Promise<{ rows: Array<Record<string, unknown>> }>;
  execute(plan: ExecutionPlan, options: { finalize(info: { rowsAffected: number; client: unknown }): Promise<void> }): Promise<{ ok: true; rowsAffected: number } | { ok: false; code: string; detail?: unknown }>;
}

export interface GovernanceStore {
  put(record: Record<string, unknown>): Promise<{ record: any; created: boolean }>;
  get(organisationId: string, id: string): Promise<any | null>;
  findByIdempotencyKey(organisationId: string, key: string): Promise<any | null>;
  transition(organisationId: string, id: string, change: { from: Status[]; to: Status; patch?: Record<string, unknown>; at: string }, options?: { client?: unknown }): Promise<any | null>;
  list(filter: { organisationId: string; status?: Status | Status[]; limit?: number }): Promise<any[]>;
}

export interface ProposeInput {
  organisationId: string;
  agent: { id: string; model?: string; instructions?: string };
  requestedBy?: { kind: string; id: string } | null;
  intent: { code: string; confidence?: number };
  actions: Action[];
  explanation?: string;
  idempotencyKey?: string;
  id?: string;
}

export interface DataGovernanceOptions {
  governor: { isHalted(organisationId?: string): Promise<boolean> };
  auditStore: { appendAudit(entry: Record<string, unknown>): Promise<unknown> };
  store: GovernanceStore;
  connectors: Record<string, Connector>;
  rules?: Rule[];
  /** Les règles lues ailleurs (un tableau de bord) : vérifiées ici à chaque lecture, d'où des objets quelconques acceptés. */
  remoteRules?: (context: { organisationId: string; environment: string }) => Promise<{ version?: unknown; rules?: ReadonlyArray<Rule | Record<string, unknown>> }>;
  trust?: TrustInput;
  environment?: string;
  proposalTtlMs?: number;
  undoWindowMs?: number;
  quotas?: { perDay?: number; timeZone?: string; store?: { getSpent(scope: string, period: string): Promise<number>; addSpend(entry: { scope: string; period: string; id: string; amount: number; at: string }): Promise<{ added: boolean; spent: number }> } };
  now?: () => number;
  idFactory?: () => string;
  onEvent?: (event: Record<string, unknown>) => unknown;
  onError?: (error: unknown) => unknown;
}

export interface DataGovernance {
  propose(input: ProposeInput): Promise<ProposalView>;
  /** `validation` vient du réseau : tout est vérifié ici (signature d'abord), d'où `unknown`. */
  applyValidation(validation: unknown, options: { organisationId: string }): Promise<ProposalView>;
  undo(id: string, options: { organisationId: string; by: { kind: 'human'; id: string } }): Promise<ProposalView>;
  expire(options: { organisationId: string }): Promise<string[]>;
  get(id: string, options: { organisationId: string }): Promise<ProposalView | null>;
  list(filter: { organisationId: string; status?: Status | Status[]; limit?: number }): Promise<ProposalView[]>;
  challengeFor(proposal: Proposal, options: { decision: Decision; approver: string; nonce: string }): string;
  verifyDigest(proposal: unknown): boolean;
  /** La confiance mesurée sur les propositions gardées ici : des suggestions, jamais appliquées. */
  trustReport(options: { organisationId: string; limit?: number } & TrustOptions): Promise<TrustReport[]>;
  readonly environment: string;
}

export type TrustOutcome = 'approved' | 'declined' | 'undone' | 'unreviewed' | 'unknown';
export declare const TRUST_OUTCOMES: readonly TrustOutcome[];
export interface TrustEntry { id: string; agent: string; resource: string; ops: string[]; level: Level; confidence?: number | null; outcome: TrustOutcome; at?: string }
export interface TrustOptions { minimumSample?: number; loosenAbove?: number; tightenUndone?: number; tightenRate?: number; level?: 0.9 | 0.95 | 0.99 }
export interface TrustReport {
  agent: string; resource: string; ops: string[]; level: Level; counts: Record<TrustOutcome, number>;
  sampleSize: number; rate: number | null; interval: { low: number; high: number; level: number } | null; status: 'observed' | 'insufficient_data';
  calibration: { sampleSize: number; brierScore: number | null; confidenceGap: number | null; overconfidence: number | null; underconfidence: number | null; status: string } | null;
  suggestion: { action: 'loosen' | 'tighten'; from: Level; to: Level; reasons: string[]; rule: Rule } | null;
}
export declare function trustSuggestions(entries: TrustEntry[], options?: TrustOptions): TrustReport[];
export declare function trustEntriesFromRecords(records: unknown[]): TrustEntry[];
export declare function outcomeOfRecord(record: unknown): TrustOutcome;

export declare function createDataGovernance(options: DataGovernanceOptions): DataGovernance;
export declare function defineResources(declaration: Record<string, ResourceDeclaration>): Readonly<Record<string, Resource>>;
export declare function normalizeRules(rules: Rule[] | null | undefined, origin?: 'local' | 'remote'): readonly Rule[];
export declare function decideLevel(input: { groups: Array<{ resource: string; ops: Operation[]; tags: string[]; rows: number; amount: number }>; agent: string; at: number; rules: readonly Rule[] }): { level: Level; approvals: number; matched: Array<{ id: string | null; origin: string; level: Level; resource: string }>; quotaRules: Rule[] };
export declare function challengeFor(input: { propositionId: string; digest: string; decision: Decision; environment: string; approver: string; nonce: string }): string;
export declare function signValidation(validation: Omit<Validation, 'schema' | 'keyId' | 'signature'>, options: { privateKey: string | KeyObject; keyId: string }): Validation;
export declare function verifyValidation(validation: unknown, options: { trust: Trust; proposal: Proposal; environment: string; now?: number }): { ok: true; decision: Decision; approvers: string[] } | { ok: false; code: string };
export declare function createTrust(trust: TrustInput): Trust;
export declare function stableStringify(value: unknown): string;
export declare function digestOf(value: unknown): string;
export declare function createMemoryGovernanceStore(): GovernanceStore;
export interface CommandDeclaration {
  fields: string[];
  sensitive?: string[];
  tags?: string[];
  amount?: string;
  recheck?(values: Record<string, unknown>): Promise<string | null | undefined> | string | null | undefined;
  run(values: Record<string, unknown>, context: { idempotencyKey: string }): Promise<{ count?: number } | void> | { count?: number } | void;
}
export declare function createCommandConnector(options: { commands: Record<string, CommandDeclaration> }): Connector & { readonly singleAction: true; readonly undoable: false };
export declare function createMemoryConnector(options: { resources: Record<string, ResourceDeclaration>; data?: Record<string, Array<Record<string, unknown>>> }): Connector & {
  snapshot(name: string): Array<Record<string, unknown>>;
  mutate(name: string, fn: (rows: Array<Record<string, unknown>>) => void): void;
};
