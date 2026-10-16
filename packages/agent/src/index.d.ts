export * from './feedback';
import type { NativeTool, NativeToolCall, ToolMessage } from '@astratra/ai';
import type { Guards, GuardRunSnapshot } from '@astratra/ai/guards';
export type PlanState = 'todo' | 'in_progress' | 'done' | 'abandoned';
export interface PlanStep { id: string; text: string; state: PlanState }
export type TaskState = 'pending' | 'running' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';
export interface Usage { inputTokens: number; outputTokens: number; cost: number }
export interface TurnUsage extends Usage { turn: number; phase: string; estimated: boolean }
export interface Message { role: string; text?: string | null; toolCalls?: NativeToolCall[]; [key: string]: unknown }
export interface Task {
  id: string; question: string; state: TaskState; messages: Message[]; plan: PlanStep[];
  turns: number; elapsedMs: number; usage: Usage; usageHistory: TurnUsage[];
  steps: Array<{ key: string; call: NativeToolCall; result: ToolMessage }>;
  pending: { step: number; calls: NativeToolCall[]; results: Array<ToolMessage | null>; preparations?: Array<ToolMessage | null> } | null;
  verificationRetries: number; verified: boolean; createdAt: number; updatedAt: number;
  userId?: string; tenantId?: string; feedbackDigest?: string;
  /** Question as the model saw it (names and personal data masked); set when guards are on. */
  maskedQuestion?: string;
  /** State of the guards, kept so a resumed task behaves the same. Holds the masking table: store it like the data it protects. */
  guards?: { version: 1; inputDone: boolean; run?: GuardRunSnapshot };
  /** Last reply check when it was not a plain allow: decision, reason codes, numbers (no text). */
  guard?: { decision: 'allow' | 'flag' | 'block'; reasons: string[]; degraded: string[]; groundingScore: number | null; unsupportedClaims: number };
  confirmation?: { key: string; call: NativeToolCall; prepared?: unknown; guard?: { requiresConfirmation?: boolean; reason?: string } }; text?: string; error?: string; stopReason?: string;
}
export interface TaskStore {
  create(task: Task): Promise<Task>; get(id: string): Promise<Task | null>;
  acquire(id: string, owner: string, leaseMs: number): Promise<boolean>;
  renew(id: string, owner: string, leaseMs: number): Promise<boolean>;
  save(task: Task, owner: string): Promise<Task>; release(id: string, owner: string): Promise<void>;
}
export interface Budget { maxMs?: number; maxTurns?: number; maxTokens?: number; maxCost?: number }
export interface TurnRequest {
  system: string; messages: Message[]; tools: Array<Record<string, unknown>>; signal: AbortSignal; phase: string;
  /**
   * Avec des gardes : rend les vrais mots d'un texte du modèle (masqué). Pour montrer une réponse pendant qu'elle
   * s'écrit (`onText` de @astratra/ai) ; la réponse finale, elle, passe toujours par la garde de sortie.
   */
  unmask?: (text: string) => string;
}
export interface TurnResponse { text?: string; toolCalls?: NativeToolCall[]; usage?: { inputTokens?: number; outputTokens?: number; prompt_tokens?: number; completion_tokens?: number; cost?: number } }
export interface Verification { complete: boolean; feedback?: string }
export interface SummaryInput { messages: Message[]; plan: PlanStep[]; signal: AbortSignal }
export interface ContextSummaryOptions { maxChars?: number; maxTokens?: number; keepLast?: number }
export interface AgentOptions {
  turn(request: TurnRequest): Promise<TurnResponse> | TurnResponse;
  /**
   * Guards from `createGuards` / `recommendedGuards` (`@astratra/ai/guards`), or `false` to run without.
   * Required in production (`NODE_ENV=production`); elsewhere a missing choice sends one `warning` event.
   */
  guards?: Guards | false;
  /** Tools marked `external: true` return outside content (web, e-mail, files): scanned for injection and framed as data. */
  tools?: Array<NativeTool<any> & { external?: boolean }>; system?: string; context?: Record<string, unknown>; store?: TaskStore;
  budget?: Budget; pricing?: { inputPerMillion?: number; outputPerMillion?: number };
  verify?(input: { task: Task; text: string; signal: AbortSignal }): Promise<boolean | Verification> | boolean | Verification;
  verificationInstruction?: string; maxVerificationRetries?: number;
  contextSummary?: ContextSummaryOptions; summarize?(input: SummaryInput): Promise<string> | string;
  summaryInstruction?: string; finalInstruction?: string; finalMs?: number; toolTimeoutMs?: number;
  feedback?: { feedbackDigest(input: { userId: string; tenantId?: string }): Promise<string> | string } | ((input: { userId?: string; tenantId?: string; task: Task; signal: AbortSignal }) => Promise<string> | string);
  leaseMs?: number; now?(): number; onEvent?(event: { type: string; taskId: string; [key: string]: unknown }): void | Promise<void>;
}
export interface TaskInput { id?: string; question: string; messages?: Message[]; userId?: string; tenantId?: string }
export interface ExecutionOptions { signal?: AbortSignal; confirmation?: { key: string; approved: boolean } }
export interface Agent { store: TaskStore; create(input: TaskInput): Promise<Task>; resume(id: string, options?: ExecutionOptions): Promise<Task>; run(input: TaskInput, options?: ExecutionOptions): Promise<Task> }
export function createAgent(options: AgentOptions): Agent;
export const TASK_STATES: readonly TaskState[];
export const PLAN_STATES: readonly PlanState[];
export function validateTask(task: Task): Task;
export function validatePlan(steps: PlanStep[]): PlanStep[];
export function createPlanTool(update: (plan: PlanStep[]) => void | Promise<void>): NativeTool;
export function createMemoryTaskStore(options?: { now?(): number }): TaskStore;
export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export function createPostgresTaskStore(db: Queryable, options?: { table?: string }): TaskStore;
export function postgresTaskSchema(options?: { table?: string }): string;
export function estimateTokens(value: unknown): number;
export function normalizeBudget(budget?: Budget): Budget & { maxMs: number; maxTurns: number };
export function usageOf(request: unknown, response: TurnResponse, pricing?: AgentOptions['pricing']): Usage & { estimated: boolean };
export function budgetReason(task: Pick<Task, 'turns' | 'elapsedMs' | 'usage'>, budget: ReturnType<typeof normalizeBudget>): string | null;
export function contextBoundary(messages: Message[], options?: ContextSummaryOptions): number;
export function summarizeContext(messages: Message[], plan: PlanStep[], options: ContextSummaryOptions, summarize: (input: { messages: Message[]; plan: PlanStep[] }) => Promise<string> | string): Promise<boolean>;

// Scheduler: timed tasks, one run at a time, injectable lock and state store.
export type Schedule =
  | { type: 'daily'; at: string }
  | { type: 'weekly'; at: string; day: number | string; days?: never }
  | { type: 'weekly'; at: string; days: Array<number | string>; day?: never }
  | { type: 'interval'; everyMs: number };
export interface ScheduledRunContext { id: string; signal: AbortSignal; manual: boolean; scheduledFor: number | null; previous: unknown; now: number }
export interface ScheduledTask { id: string; label?: string; schedule: Schedule; timeZone?: string; enabled?: boolean; maxLateMs?: number; run(context: ScheduledRunContext): unknown }
export interface Lock { acquire(key: string): Promise<{ release(): Promise<void> } | null> }
export interface ScheduleState {
  id: string; status: 'scheduled' | 'running' | 'ok' | 'error' | 'skipped'; nextRunAt: number | null; lastStartedAt: number | null; lastRunAt: number | null;
  lastResult: unknown; lastError: { message: string; at: number } | null; skipReason: string | null; lastManual: boolean;
}
export interface ScheduleStateStore { get(id: string): Promise<Record<string, unknown> | null>; set(id: string, state: Record<string, unknown>): Promise<void> }
export interface SchedulerEvent { type: 'start' | 'done' | 'error' | 'skipped'; id: string; manual?: boolean; reason?: string; error?: string }
export interface SchedulerOptions {
  tasks: ScheduledTask[]; timeZone?: string; lock?: Lock; store?: ScheduleStateStore; now?(): number | Date;
  tickMs?: number; maxLateMs?: number; stopCheckMs?: number; shouldStop?(): boolean | Promise<boolean>;
  onEvent?(event: SchedulerEvent): void | Promise<void>; onError?(error: unknown, taskId: string): void;
}
export type RunOutcome = { id: string; status: 'ok' | 'error' | 'skipped' | 'scheduled' | 'locked' | 'already_done'; result?: unknown; error?: string; reason?: string };
export type TaskView = ScheduleState & { label: string; enabled: boolean; timeZone: string };
export interface Scheduler {
  tick(): Promise<RunOutcome[]>; start(): void; stop(): void; readonly started: boolean; abortAll(reason?: unknown): void;
  run(id: string, options?: { signal?: AbortSignal }): Promise<RunOutcome>;
  state(): Promise<TaskView[]>;
  state(id: string): Promise<TaskView>;
}
export class SchedulerError extends Error { code: 'unknown_task' | 'stopped' | 'running' | (string & {}); constructor(code: string, message?: string) }
export function createScheduler(options: SchedulerOptions): Scheduler;
export function createMemoryLock(): Lock;
export function createMemoryScheduleStore(): ScheduleStateStore;
export function nextRun(schedule: Schedule, after: number, timeZone?: string): number;
export function zonedTime(date: string, hour: number, minute: number, timeZone: string): number;

// Approval queue: proposed actions decided later by an authenticated person (the caller authenticates).
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export const APPROVAL_STATUSES: readonly ApprovalStatus[];
export interface ApprovalAction<I = unknown, R = unknown> {
  id: string; type: string; input: I; requestedBy: string; meta: unknown; status: ApprovalStatus; createdAt: number; expiresAt: number | null;
  decidedBy: string | null; decidedAt: number | null; executedAt: number | null; result: R | null; reason: string | null;
  refusal: { reason: string; details: unknown; at: number; by: string } | null;
}
export interface ApprovalFilter { status?: ApprovalStatus; type?: string; requestedBy?: string; limit?: number; before?: number }
export interface ApprovalStore {
  create(action: ApprovalAction): Promise<ApprovalAction>; get(id: string): Promise<ApprovalAction | null>;
  list(filter?: ApprovalFilter): Promise<ApprovalAction[]>;
  reserve(id: string, decidedBy: string, at: number): Promise<ApprovalAction | null>;
  finish(id: string, result: unknown, at: number): Promise<ApprovalAction | null>;
  revert(id: string, decidedBy: string, refusal: unknown): Promise<ApprovalAction | null>;
  reject(id: string, decidedBy: string, reason: string | null, at: number): Promise<ApprovalAction | null>;
  expire(at: number): Promise<ApprovalAction[]>;
}
export type Decider = string | { id: string; [key: string]: unknown };
export interface ExecutorContext<I = any> { action: ApprovalAction<I>; input: I; decider: Decider; idempotencyKey: string; signal: AbortSignal }
export type Executor = (context: ExecutorContext) => unknown;
export interface ApprovalEvent { type: 'proposed' | 'approved' | 'rejected' | 'refused' | 'failed' | 'expired'; action: ApprovalAction; result?: unknown; reason?: string; error?: string }
export interface ApprovalQueueOptions {
  store?: ApprovalStore; now?(): number | Date; executors?: Executor | Record<string, Executor>; executionTimeoutMs?: number;
  authorize?(input: { action: ApprovalAction; decider: Decider; decision: 'approve' | 'reject' }): boolean | void | Promise<boolean | void>;
  beforeExecute?(input: { action: ApprovalAction; decider: Decider }): void | Promise<void>;
  onEvent?(event: ApprovalEvent): void | Promise<void>;
}
export interface ApprovalQueue {
  propose(input: { type: string; input?: unknown; requestedBy: string; ttlMs?: number; expiresAt?: number | Date; meta?: unknown; id?: string }): Promise<ApprovalAction>;
  get(id: string): Promise<ApprovalAction | null>; list(filter?: ApprovalFilter): Promise<ApprovalAction[]>; expire(): Promise<ApprovalAction[]>;
  approve(id: string, options: { decider: Decider; signal?: AbortSignal }): Promise<{ action: ApprovalAction; result: unknown }>;
  reject(id: string, options: { decider: Decider; reason?: string }): Promise<ApprovalAction>;
}
export class ApprovalError extends Error { code: 'not_found' | 'expired' | 'already_decided' | 'forbidden' | 'no_executor' | 'execution_failed' | 'invalid' | (string & {}); constructor(code: string, message?: string, options?: { cause?: unknown }) }
export class ApprovalRefused extends Error { reason: string; details: unknown; constructor(reason: string, details?: unknown) }
export function createApprovalQueue(options?: ApprovalQueueOptions): ApprovalQueue;
export function createMemoryApprovalStore(): ApprovalStore;

// PostgreSQL implementations.
export interface PgPool extends Queryable { connect(): Promise<Queryable & { release(): void }> }
export function createPostgresLock(pool: PgPool, options?: { prefix?: string }): Lock;
export function postgresScheduleSchema(options?: { table?: string }): string;
export function createPostgresScheduleStore(db: Queryable, options?: { table?: string }): ScheduleStateStore;
export function postgresApprovalSchema(options?: { table?: string }): string;
export function createPostgresApprovalStore(db: Queryable, options?: { table?: string }): ApprovalStore;
