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
