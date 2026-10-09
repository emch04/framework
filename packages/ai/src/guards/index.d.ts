export type GuardDecision = 'allow' | 'flag' | 'block';
export type FailurePolicy = 'failClosed' | 'failOpen';
export type RunMode = 'action' | 'read';

/** The part of the @astratra/models client the guards use. Inject the client; nothing is imported. */
export interface GuardModels {
  entities?(text: string, labels?: string[]): Promise<{ ok: true; entities: Array<{ text: string; label: string; start: number; end: number; score: number }> } | { ok: false; code: string }>;
  injection?(texts: string[]): Promise<{ ok: true; results: Array<{ score: number; verdict: 'injection' | 'safe' }> } | { ok: false; code: string }>;
  moderation?(texts: string[]): Promise<{ ok: true; results: Array<{ flagged: boolean; unsafe: number; categories: Record<string, number>; flaggedCategories: string[] }> } | { ok: false; code: string }>;
  nli?(pairs: Array<{ premise: string; hypothesis: string }>): Promise<{ ok: true; results: Array<{ entailment: number; neutral: number; contradiction: number }> } | { ok: false; code: string }>;
}

export interface GuardPolicy {
  /** What a guard does when a model it needs is down. By run mode; default failClosed for both. */
  failure?: { action?: FailurePolicy; read?: FailurePolicy };
  /** Suspected injection in a tool result: keep the content framed (`flag`, default) or withhold it. */
  onInjection?: 'flag' | 'withhold';
  /** Personal data in a reply that the person did not give in this run. Default `block`. */
  onLeak?: 'block' | 'redact' | 'flag';
  /** Reply flagged by moderation. Default `block`. */
  onModeration?: 'block' | 'flag';
  /** Reply claims the sources do not support. Default `flag`. */
  onUnsupported?: 'flag' | 'block';
}

/** One per decision, for logging. Numbers, codes and category names: never the text. */
export interface GuardEvent {
  type: 'guard';
  guard: 'input' | 'toolResult' | 'output' | 'beforeAction';
  runId: string;
  mode: RunMode;
  at: string;
  decision: GuardDecision;
  reasons: string[];
  /** Checks that could not run (model down). */
  degraded: string[];
  metrics: Record<string, unknown>;
}

export interface GuardRun {
  id: string;
  mode: RunMode;
  /** Raw external texts read in this run: what replies are checked against. */
  sources: string[];
  /** True once an injection is suspected: no action without human confirmation for the rest of the run. */
  requiresConfirmation: boolean;
  suspicions: number;
  unmask(text: string): string;
}

export interface CreateGuardsOptions {
  models?: GuardModels;
  policy?: GuardPolicy;
  onEvent?: (event: GuardEvent) => void;
  /** Names always masked. */
  names?: string[];
  /** Entity labels masked. Default ['person']. */
  entityLabels?: string[];
  injection?: {
    /** Score from which external content is suspect. Default 0.5. */
    threshold?: number;
    /** Same, for a run that can act. Default: threshold. */
    actionThreshold?: number;
    /** Content beyond this is dropped, never passed unchecked. Default 100 000. */
    maxScanChars?: number;
    chunkChars?: number;
    overlapChars?: number;
  };
  output?: {
    grounding?: boolean;
    leak?: boolean;
    moderation?: boolean;
    /** Share of supported claims under which the reply is `unsupported`. Default 0.5. */
    minSupport?: number;
    leakTypes?: Array<'email' | 'iban' | 'card' | 'phone'>;
    allowLeak?: (item: { type: string; key: string }, run: GuardRun) => boolean;
  };
  /** `verifySources` of @astratra/rag; default: the installed @astratra/rag. */
  verifySources?: (answer: string, sources: unknown[], options: { nli: (pairs: Array<{ premise: string; hypothesis: string }>) => Promise<unknown[]> }) => Promise<{ code: string; claims: Array<{ category: string; claim: string; source: string | null }> }>;
  defaultMode?: RunMode;
  nonce?: () => string;
  now?: () => string;
}

export interface InputResult { decision: GuardDecision; /** Null when blocked. */ text: string | null; degraded: string[]; masked: number; event?: GuardEvent }
export interface ToolResultContext { tool?: string; /** True for content from outside (web, e-mail, files, other people). */ external?: boolean }
export interface ToolResultOutcome {
  decision: GuardDecision;
  /** Put this in the context: masked and, for external content, framed as untrusted data. */
  content: string;
  framed: boolean;
  suspected: boolean;
  score?: number | null;
  degraded: string[];
  requiresConfirmation?: boolean;
  truncated?: boolean;
}
export interface OutputResult {
  decision: GuardDecision;
  /** Unmasked reply (leaks removed under `redact`); null when blocked. */
  text: string | null;
  reasons: string[];
  degraded: string[];
  groundingScore: number | null;
  /** Sentences the sources do not support. */
  unsupported: Array<{ claim: string; contradicted: boolean }>;
  leaks: Array<{ type: string; start: number; end: number }>;
  moderation: { flagged: boolean; unsafe: number; categories: string[] } | null;
  event: GuardEvent;
}

export interface Guards {
  newRun(options?: { id?: string; mode?: RunMode; sources?: string[]; names?: string[] }): GuardRun;
  input(text: string, run: GuardRun): Promise<InputResult>;
  toolResult(result: unknown, run: GuardRun, context?: ToolResultContext): Promise<ToolResultOutcome>;
  output(text: string, run: GuardRun, context?: { sources?: string[] }): Promise<OutputResult>;
  beforeAction(action: { name?: string; [key: string]: unknown }, run: GuardRun, context?: { humanConfirmed?: boolean }): Promise<{ decision: GuardDecision; reason?: string; needsConfirmation: boolean }>;
  policy: Required<GuardPolicy>;
}

export function createGuards(options?: CreateGuardsOptions): Guards;
/** Every check on, failClosed for actions, 0.3 injection threshold before an action, leaks and unsafe replies blocked. */
export function recommendedGuards(options?: CreateGuardsOptions & { readOnly?: boolean }): Guards;
export function frameUntrusted(content: string, options?: { source?: string; nonce?: string }): string;
export function findPersonalData(text: string, types?: string[]): Array<{ type: string; value: string; key: string; start: number; end: number }>;
export const UNTRUSTED_NOTICE: string;
export const GUARD_DECISIONS: readonly GuardDecision[];
export const FAIL_CLOSED: 'failClosed';
export const FAIL_OPEN: 'failOpen';
