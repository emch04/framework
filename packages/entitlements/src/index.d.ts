/*
 * Structural express types, declared here rather than pulled from @types/express:
 * this package has no runtime dependencies and should not force a type
 * dependency on its consumers either.
 */
export interface RequestLike {
  user?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResponseLike {
  status(statusCode: number): { json(payload: unknown): unknown; send(payload: unknown): unknown };
  [key: string]: unknown;
}

export type NextFunction = (error?: unknown) => unknown;
export type RequestHandler = (req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;
export type Awaitable<T> = T | Promise<T>;

export interface DeniedPayload {
  status: number;
  message: string;
  details: Record<string, unknown>;
}

export type Responder = (res: ResponseLike, payload: DeniedPayload) => unknown;
export type ErrorPolicy = 'allow' | 'deny';

export interface PlanCatalog {
  plans: string[];
  fallbackPlan: string;
  knows(plan: string): boolean;
  hasFeature(plan: string, feature: string, overrides?: string[]): boolean;
  featuresOf(plan: string): string[];
  labelOf(plan: string): string;
  upgradeFrom(plan: string): string | null;
  allFeatures(): string[];
}

export function createPlanCatalog(options: {
  plans: Record<string, string[]>;
  labels?: Record<string, string>;
  upgradePath?: Record<string, string>;
  fallbackPlan?: string;
}): PlanCatalog;

export interface ResolvedAccount {
  plan: string;
  overrides?: string[];
}

export function createFeatureGuard(options: {
  catalog: PlanCatalog;
  resolveAccount: (req: RequestLike) => Awaitable<ResolvedAccount | null>;
  isExempt?: (req: RequestLike) => boolean;
  isEnabled?: (feature: string) => Awaitable<boolean>;
  respond?: Responder;
  onError?: ErrorPolicy;
  onErrorLog?: (error: unknown, feature: string) => void;
}): (feature: string) => RequestHandler;

export interface ResolvedStatus {
  status: string;
  name?: string;
  reason?: string;
}

export function createStatusGuard(options: {
  resolveStatus: (req: RequestLike) => Awaitable<ResolvedStatus | null>;
  blockedStatuses?: string[];
  isExempt?: (req: RequestLike) => boolean;
  message?: (account: ResolvedStatus) => string;
  respond?: Responder;
  onError?: ErrorPolicy;
  onErrorLog?: (error: unknown) => void;
}): RequestHandler;

export interface CommissionResult {
  rate: number;
  commission: number;
  net: number;
}

export interface CommissionSchedule {
  defaultRate: number;
  rateFor(plan: string): number;
  commissionOn(amount: number, plan: string): CommissionResult;
}

export function createCommissionSchedule(options: {
  defaultRate: number;
  rates?: Record<string, number>;
  round?: (amount: number) => number;
}): CommissionSchedule;

export interface AccessMatrix {
  screens: string[];
  knows(screen: string): boolean;
  canAccess(screen: string, role: string): boolean;
  rolesFor(screen: string): string[];
  screensFor(role: string): string[];
  allRoles(): string[];
}

export function createAccessMatrix(options: {
  screens: Record<string, string[]>;
  superRoles?: string[];
}): AccessMatrix;

export function except(roles: string[], ...excluded: Array<string | string[]>): string[];

export interface TenantScope<User = Record<string, unknown>> {
  /** Adds the tenant filter. NO TENANT MEANS NO ROWS — never all rows. Returns a new object. */
  scope(user: User | null | undefined, query?: Record<string, unknown>): Record<string, unknown>;
  canAccess(user: User | null | undefined, documentTenant: unknown): boolean;
  field: string;
}

export function createTenantScope<User = Record<string, unknown>>(options: {
  /** The tenant field on your documents — 'school', 'organisation', 'shopId'… */
  field: string;
  globalRoles?: string[];
  tenantOf?: (user: User | null | undefined) => unknown;
  /** What a no-tenant filter matches on — pass an impossible ObjectId for strict stores. */
  impossibleValue?: unknown;
  /** A user with no tenant is worth an alarm, not just an empty screen. */
  onMissingTenant?: (user: User | null | undefined) => void;
}): TenantScope<User>;

/* ────────────────────────── Invitations ────────────────────────── */

export type InvitationStatus = 'pending' | 'used' | 'expired' | 'revoked' | 'failed';

export class InvitationError extends Error {
  statusCode: number;
}

export interface Invitation {
  id: string;
  email: string | null;
  role: string;
  /** The token's fingerprint — the token itself is never stored. */
  tokenHash: string;
  status: InvitationStatus;
  invitedBy: unknown;
  tenant: unknown;
  meta: Record<string, unknown> | null;
  createdAt: Date | string;
  expiresAt: Date | string;
  usedAt?: Date | string;
  revokedBy?: unknown;
  revokedAt?: Date | string;
  failReason?: string;
  [key: string]: unknown;
}

export interface InvitationStore {
  create(data: Record<string, unknown>): Awaitable<Invitation>;
  findByTokenHash(tokenHash: string): Awaitable<Invitation | null>;
  /** Atomic status transition: null when the record was not in `from`. */
  claim(id: string, from: InvitationStatus[], patch: Record<string, unknown>): Awaitable<Invitation | null>;
  update(id: string, patch: Record<string, unknown>): Awaitable<Invitation | null>;
  retirePending?(email: string): Awaitable<void>;
  list?(filter?: Record<string, unknown>): Awaitable<Invitation[]>;
}

export function createMemoryInvitationStore(): InvitationStore & {
  retirePending(email: string): Promise<void>;
  list(filter?: Record<string, unknown>): Promise<Invitation[]>;
  size(): number;
};

export interface Invitations<Account = unknown, Form = Record<string, unknown>> {
  /** The token is returned HERE and never again — the store keeps only its hash. */
  invite(input: {
    email?: string | null;
    role: string;
    invitedBy: unknown;
    tenant?: unknown;
    meta?: Record<string, unknown>;
  }): Promise<{ invitation: Invitation; token: string; url: string | null }>;
  /** What the registration page needs to render. */
  verify(token: string): Promise<{ email: string | null; role: string; tenant: unknown; invitationId: string }>;
  /** Atomic single-use claim, then account creation. A failed creation marks FAILED, never used. */
  accept(token: string, form?: Form): Promise<{ invitation: Invitation; account: Account }>;
  revoke(id: string, review: { revokedBy: unknown }): Promise<Invitation>;
  list(filter?: Record<string, unknown>): Promise<Invitation[]>;
  hashToken(token: string): string;
  roles: string[];
}

export function createInvitations<Account = unknown, Form = Record<string, unknown>>(options: {
  store: InvitationStore;
  roles: string[];
  /** Runs INSIDE acceptance; must throw when the account cannot be created. */
  createAccount: (invitation: Invitation, form: Form) => Awaitable<Account>;
  ttlMs?: number;
  buildUrl?: (token: string, invitation: Invitation) => string;
  /** A delivery failure does NOT destroy the invitation. */
  deliver?: (input: { invitation: Invitation; url: string | null; token: string }) => Awaitable<void>;
  now?: () => number;
  logger?: { warn?(m: string): void; info?(m: string): void };
}): Invitations<Account, Form>;

/* ─────────────── The invitation list, as a screen sees it ─────────────── */

export type InvitationTone = 'success' | 'warning' | 'danger' | 'neutral';
export type InvitationTab = 'pending' | 'accepted' | 'closed';

export const URGENT_HOURS: number;

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  /** As the payload stated it. Use effectiveStatus() to know where it stands. */
  status: InvitationStatus;
  expiresAt: string | null;
  usedAt: string | null;
  createdAt: string | null;
  failReason: string;
}

export interface InvitationBoard {
  readonly tabs: InvitationTab[];
  readonly urgentHours: number;
  read(raw: unknown): InvitationRow | null;
  readMany(payload: unknown): InvitationRow[];
  /** A pending invitation past its date is expired, whatever the server said. */
  effectiveStatus(invitation: InvitationRow | null | undefined, now?: Date): InvitationStatus;
  hoursLeft(invitation: InvitationRow, now?: Date): number | null;
  tone(invitation: InvitationRow, now?: Date): InvitationTone;
  counts(invitations: InvitationRow[], now?: Date): { total: number; pending: number; accepted: number };
  /** 'closed' gathers expired and failed: both need a new invitation. */
  filter(invitations: InvitationRow[], tab: InvitationTab, now?: Date): InvitationRow[];
  tabCounts(invitations: InvitationRow[], now?: Date): Record<InvitationTab, number>;
  initialTab(invitations: InvitationRow[], now?: Date): InvitationTab;
  invitableRoles(role: string | undefined): string[];
  canInvite(role: string | undefined): boolean;
  looksLikeEmail(value: unknown): boolean;
}

export function createInvitationBoard(options?: {
  urgentHours?: number;
  invitable?: Record<string, string[]>;
}): InvitationBoard;

/* ─────────────── A role only one account may hold ─────────────── */

export type UniqueRoleReason = 'role_taken' | 'bootstrap_closed' | 'identity_taken' | 'holder_protected' | 'last_holder';

export class UniqueRoleError extends Error {
  reason: UniqueRoleReason;
  statusCode: number;
  constructor(reason: UniqueRoleReason, statusCode: number, message?: string);
}

export type UniqueRoleAlertKind =
  | 'create_refused'
  | 'promotion_refused'
  | 'demotion_refused'
  | 'rename_refused'
  | 'modify_refused'
  | 'intruders_removed'
  | 'anchor_missing'
  | 'anchor_not_found'
  | 'anchor_mismatch';

export interface UniqueRoleAlert<Account = Record<string, unknown>> {
  kind: UniqueRoleAlertKind;
  role: string;
  actor?: Account;
  account?: Account;
  holder?: Account | null;
  intruders?: Account[];
  failed?: Account[];
  accounts?: Account[];
  nextIdentifier?: string;
}

export interface UniqueRoleStore<Account = Record<string, unknown>> {
  /** Every account holding the role — match it case-insensitively. */
  findHolders(role: string): Awaitable<Account[]>;
  /** Remove ONLY IF the account still holds `role`; false when it did not. */
  remove?(account: Account, role: string): Awaitable<boolean | void>;
}

export type SweepReason = 'none' | 'single' | 'intruders' | 'anchor_missing' | 'anchor_not_found' | 'anchor_mismatch';

export interface SweepResult<Account = Record<string, unknown>> {
  removed: Account[];
  failed: Account[];
  holder: Account | null;
  reason: SweepReason;
  dryRun: boolean;
}

export interface UniqueRole<Account = Record<string, unknown>> {
  role: string;
  isRole(role: unknown): boolean;
  isHolder(account: Account | null | undefined): boolean;
  verdict(input: { role: unknown; otherHolderExists: boolean }):
    { refused: false } | { refused: true; reason: UniqueRoleReason; statusCode: number };
  /** Throws UniqueRoleError (and alerts) when a second holder would be created. */
  assertCanCreate(input: { role: unknown; actor?: Account; account?: Partial<Account> }): Promise<void>;
  /** `account` as currently stored. Refuses promotion into a taken role and demotion of the holder. */
  assertCanChangeRole(input: { account: Account; nextRole: unknown; actor?: Account }): Promise<void>;
  /** Refuses anyone but the holder taking the anchored identifier. */
  assertCanRename(input: { account: Account; nextIdentifier: unknown; actor?: Account }): Promise<void>;
  /** Refuses anyone but the holder modifying or deleting the holder's account. */
  assertCanModify(input: { target: Account; actor?: Account }): Promise<void>;
  /** The sentinel: removes every holder but the anchored one, then alerts. */
  sweep(options?: { dryRun?: boolean }): Promise<SweepResult<Account>>;
}

export function createUniqueRole<Account = Record<string, unknown>>(options: {
  role: string;
  /** The legitimate holder's identifier, or a function read at each call. */
  anchor?: string | null | (() => string | null | undefined);
  store?: UniqueRoleStore<Account>;
  /** Sending and wording are yours; a failure never changes the outcome. */
  alert?: (event: UniqueRoleAlert<Account>) => Awaitable<void>;
  /** Refusal texts by reason; without one, the message is the reason code. */
  messages?: Partial<Record<UniqueRoleReason, string>>;
  /** Default true: the first holder may be created while none exists. */
  allowBootstrap?: boolean;
  idOf?: (account: Account) => unknown;
  identifierOf?: (account: Account) => unknown;
  roleOf?: (account: Account) => unknown;
  logger?: { error(message: string): void };
}): UniqueRole<Account>;

export function pickIntruders<Account = Record<string, unknown>>(input: {
  accounts?: Account[];
  anchor?: string | null;
  identifierOf?: (account: Account) => unknown;
  idOf?: (account: Account) => unknown;
}): { intruders: Account[]; holder: Account | null; reason: SweepReason };

export function createMemoryUniqueRoleStore<Account extends Record<string, unknown> = Record<string, unknown>>(
  initial?: Account[]
): UniqueRoleStore<Account> & {
  remove(account: Account, role: string): Promise<boolean>;
  add(account: Account): Account;
  update(id: string, patch: Partial<Account>): Account | undefined;
  list(): Account[];
  size(): number;
};
