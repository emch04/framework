export type Awaitable<T> = T | Promise<T>;

export interface ProviderModel {
  id: string;
  rpm?: number;
  rpd?: number;
  tpd?: number;
  complexity?: string[];
  [key: string]: unknown;
}

export interface Provider {
  id: string;
  models: ProviderModel[];
  call(prompt: string, ctx: Record<string, unknown>, model: ProviderModel): Awaitable<unknown>;
  [key: string]: unknown;
}

export interface ProviderRequest {
  complexity?: string;
  estimatedTokens?: number;
  intent?: string;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface ProviderRouterConfig {
  providers?: Provider[];
  cooldownMs?: number;
  cooldownJitterMs?: number;
  maxFailures?: number;
  degradedMs?: number;
  intentRouting?: Record<string, { preferred?: string[] }>;
  redisKeyPrefix?: string;
  redisUrl?: string;
}

export interface ProviderStats {
  provider: string;
  rpm_now: number;
  rpm_limit: number | null;
  rpd_used: number;
  rpd_limit: number | null;
  tpd_used: number;
  tpd_limit: number | null;
  cooldown: boolean;
  degraded: boolean;
  failures: number;
}

export interface ProviderRouter {
  ask(prompt: string, request?: ProviderRequest, ctx?: Record<string, unknown>): Promise<unknown>;
  /** Les entrées sont indexées par "providerId:modelId". */
  getStats(): Record<string, ProviderStats>;
  stop(): void;
}

export function createProviderRouter(config?: ProviderRouterConfig): ProviderRouter;

export interface ToolDefinition<TParams = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  type: string;
  roles: string[];
  params?: Record<string, unknown>;
  handler(params: TParams, ctx: Record<string, unknown>): Awaitable<TResult>;
}

export interface RegisteredTool<TParams = Record<string, unknown>, TResult = unknown> extends ToolDefinition<TParams, TResult> {
  params: Record<string, unknown>;
}

export interface ToolRegistry {
  register<TParams = Record<string, unknown>, TResult = unknown>(tool: ToolDefinition<TParams, TResult>): ToolDefinition<TParams, TResult>;
  getToolsForRole(role: string): RegisteredTool[];
  getToolByName(name: string): RegisteredTool | null;
  formatToolsForPrompt(role: string): string;
}

export function createToolRegistry(): ToolRegistry;

export interface AgentMessage {
  role?: string;
  content?: string;
}

export interface AgentRouter {
  ask(prompt: string, request?: ProviderRequest, ctx?: Record<string, unknown>): Awaitable<string | AsyncIterable<unknown> | null | undefined>;
}

export interface ToolCall {
  name: string;
  params: Record<string, unknown>;
}

export interface AgentLoopOptions {
  prompt: string;
  ctx?: Record<string, unknown>;
  history?: Array<string | AgentMessage>;
  registry: ToolRegistry;
  router: AgentRouter;
  userRole: string;
  maxSteps?: number;
  /**
   * Called with each text chunk as it arrives, when router.ask() returns a
   * stream — real token-by-token passthrough to your UI. The loop still
   * needs the fully-assembled text to detect a tool call, so it keeps
   * accumulating internally regardless of whether you pass this.
   */
  onChunk?: (chunk: string) => void;
  /**
   * Awaited before a detected tool call actually executes. Return (or
   * resolve to) false to deny — the loop tells the model the call was not
   * approved and continues, rather than crashing. Omit to auto-execute
   * every allowed tool call, unchanged from before.
   */
  confirmTool?: (toolCall: ToolCall, ctx: Record<string, unknown>) => Awaitable<boolean>;
}

export function runAgentLoop(options: AgentLoopOptions): Promise<string>;

export type ActionStatus = 'proposed' | 'approved' | 'rejected' | 'executing' | 'executed' | 'failed';

export interface PendingAction {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  description: string | null;
  proposedBy: unknown;
  tenant: unknown;
  dedupeKey: string | null;
  status: ActionStatus;
  proposedAt: Date;
  approvedBy?: unknown;
  approvedAt?: Date;
  rejectedBy?: unknown;
  rejectedAt?: Date;
  executedAt?: Date;
  failedAt?: Date;
  lastError?: string;
  amendedWith?: Record<string, unknown> | null;
  reviewNote?: string | null;
  [key: string]: unknown;
}

export interface ActionStore {
  create(data: Record<string, unknown>): Awaitable<PendingAction>;
  find(id: string): Awaitable<PendingAction | null>;
  /** Atomic status transition: returns null when the record was not in `from`. */
  claim(id: string, from: ActionStatus[], patch: Record<string, unknown>): Awaitable<PendingAction | null>;
  update(id: string, patch: Record<string, unknown>): Awaitable<PendingAction | null>;
  findOpenByKey?(dedupeKey: string, statuses: ActionStatus[]): Awaitable<PendingAction | null>;
  list?(filter?: Record<string, unknown>): Awaitable<PendingAction[]>;
}

export type ActionTool = (
  payload: Record<string, unknown>,
  context: { action: PendingAction; approvedBy: unknown }
) => Awaitable<unknown>;

export interface PendingActions {
  /** The agent proposes a write. Nothing runs yet. */
  propose(input: {
    action: string;
    payload?: Record<string, unknown>;
    description?: string;
    proposedBy?: unknown;
    tenant?: unknown;
    dedupeKey?: string;
  }): Promise<{ created: boolean; action: PendingAction }>;
  /** A human says yes — the tool runs once, atomically claimed. */
  approve(id: string, review: { approvedBy: unknown; amend?: Record<string, unknown> }): Promise<
    | { executed: true; action: PendingAction; result: unknown }
    | { executed: false; reason: 'already-handled' | 'failed'; error?: string }
  >;
  reject(id: string, review: { rejectedBy: unknown; note?: string }): Promise<PendingAction>;
  pending(filter?: Record<string, unknown>): Promise<PendingAction[]>;
  tools: string[];
  OPEN_STATUSES: ActionStatus[];
}

export function createPendingActions(options: {
  store: ActionStore;
  tools: Record<string, ActionTool>;
  onPending?: (action: PendingAction) => Awaitable<void>;
  now?: () => Date;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
}): PendingActions;

export function createMemoryActionStore(): ActionStore & {
  findOpenByKey(dedupeKey: string, statuses: ActionStatus[]): Promise<PendingAction | null>;
  list(filter?: Record<string, unknown>): Promise<PendingAction[]>;
  size(): number;
};

export interface FallbackAnswer {
  handled: boolean;
  answer?: Record<string, unknown> & { degraded?: boolean };
}

export interface DeterministicFallback<Input = Record<string, unknown>> {
  answer(input: Input): Promise<FallbackAnswer>;
  /** Try the provider; serve the deterministic answer when it throws, carrying the provider error. */
  withFallback<T>(ask: (input: Input) => Awaitable<T>, input: Input): Promise<
    | { degraded: false; answer: T }
    | { degraded: true; answer: Record<string, unknown>; providerError: unknown }
  >;
  intents: string[];
}

export function createDeterministicFallback<Input = Record<string, unknown>>(options: {
  responders: Record<string, (input: Input) => Awaitable<unknown>>;
  classify?: (input: Input) => string | null | undefined;
  markDegraded?: (answer: Record<string, unknown>) => Record<string, unknown>;
}): DeterministicFallback<Input>;
