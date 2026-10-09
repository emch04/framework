export * from './feedback';
import type { NativeTool, NativeToolCall, ToolMessage } from '@astratra/ai';
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
  confirmation?: { key: string; call: NativeToolCall; prepared?: unknown }; text?: string; error?: string; stopReason?: string;
}
export interface TaskStore {
  create(task: Task): Promise<Task>; get(id: string): Promise<Task | null>;
  acquire(id: string, owner: string, leaseMs: number): Promise<boolean>;
  renew(id: string, owner: string, leaseMs: number): Promise<boolean>;
  save(task: Task, owner: string): Promise<Task>; release(id: string, owner: string): Promise<void>;
}
export interface Budget { maxMs?: number; maxTurns?: number; maxTokens?: number; maxCost?: number }
export interface TurnRequest { system: string; messages: Message[]; tools: Array<Record<string, unknown>>; signal: AbortSignal; phase: string }
export interface TurnResponse { text?: string; toolCalls?: NativeToolCall[]; usage?: { inputTokens?: number; outputTokens?: number; prompt_tokens?: number; completion_tokens?: number; cost?: number } }
export interface Verification { complete: boolean; feedback?: string }
export interface SummaryInput { messages: Message[]; plan: PlanStep[]; signal: AbortSignal }
export interface ContextSummaryOptions { maxChars?: number; maxTokens?: number; keepLast?: number }
export interface AgentOptions {
  turn(request: TurnRequest): Promise<TurnResponse> | TurnResponse;
  tools?: NativeTool<any>[]; system?: string; context?: Record<string, unknown>; store?: TaskStore;
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
