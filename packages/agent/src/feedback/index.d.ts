export type Rating = 'up' | 'down';
export type FeedbackReason = 'inaccurate' | 'incomplete' | 'off_topic' | 'wrong_source' | 'too_long' | 'unsafe' | 'other' | (string & {});
export interface Feedback {
  id: string; tenantId: string | null; userId: string; runId: string; messageId: string | null;
  rating: Rating; reason: FeedbackReason | null; comment: string | null; agent: string | null; mode: string | null;
  createdAt: number; updatedAt: number;
}
export interface FeedbackKey { tenantId?: string | null; userId: string; runId: string }
export interface FeedbackInput extends FeedbackKey {
  rating: Rating; reason?: FeedbackReason | null; comment?: string | null; messageId?: string | null; agent?: string | null; mode?: string | null;
}
export interface FeedbackPatch { rating?: Rating; reason?: FeedbackReason | null; comment?: string | null; messageId?: string | null }
export interface FeedbackFilter {
  /** `undefined` matches every tenant; `null` matches records without one. */
  tenantId?: string | null; userId?: string; runId?: string; rating?: Rating; reason?: string; agent?: string; mode?: string;
  since?: number; until?: number; limit?: number;
}
export type FeedbackGroupBy = 'agent' | 'mode' | 'reason' | 'day';
export interface FeedbackStore {
  put(record: Omit<Feedback, never>): Promise<{ record: Feedback; created: boolean }>;
  get(key: FeedbackKey): Promise<Feedback | null>;
  remove(key: FeedbackKey): Promise<boolean>;
  list(filter?: FeedbackFilter): Promise<Feedback[]>;
  aggregate(filter?: Omit<FeedbackFilter, 'limit' | 'userId' | 'runId' | 'rating' | 'reason'> & { groupBy?: FeedbackGroupBy }): Promise<Array<{ key: string | null; up: number; down: number }>>;
}
export interface FeedbackRates { total: number; up: number; down: number; upRate: number | null; downRate: number | null }
export interface FeedbackStats extends FeedbackRates { groupBy: FeedbackGroupBy | null; groups: Array<FeedbackRates & { key: string }> }
export type Masker = (text: string) => string | Promise<string>;
export interface RunSnapshot { question: string; mode?: string; tools?: Array<string | { name: string }>; answer?: string }
export type RunReader = (input: { runId: string; tenantId: string | null }) => Promise<RunSnapshot | null | undefined> | RunSnapshot | null | undefined;
export interface FeedbackOptions {
  store: FeedbackStore; reasons?: string[]; maxComment?: number; mask?: Masker; readRun?: RunReader; salt?: string;
  reasonHints?: Record<string, string>; now?(): number; newId?(): string;
}
export interface DigestOptions {
  userId: string; tenantId?: string | null; since?: number; limit?: number; maxChars?: number;
  includeNotes?: boolean; maxNotes?: number; noteChars?: number; mask?: Masker;
}
export interface ScenarioCandidate {
  id: string; name: string; input: string; question: string; mode: string | null;
  tools: Array<{ name: string }>; expect: { tools: string[]; content: Array<string | RegExp> }; score: null;
  feedback: { rating: Rating; reason: string | null; comment: string | null }; answer?: string;
}
export interface ExportOptions {
  rating?: Rating; since?: number; until?: number; tenantId?: string | null; limit?: number;
  mask?: Masker; readRun?: RunReader; salt?: string; includeAnswer?: boolean;
}
export interface FeedbackService {
  reasons: readonly string[]; maxComment: number;
  give(input: FeedbackInput): Promise<{ feedback: Feedback; created: boolean }>;
  get(key: FeedbackKey): Promise<Feedback | null>;
  update(key: FeedbackKey, patch: FeedbackPatch): Promise<Feedback>;
  remove(key: FeedbackKey): Promise<boolean>;
  list(filter?: FeedbackFilter): Promise<Feedback[]>;
  stats(filter?: Omit<FeedbackFilter, 'limit' | 'userId' | 'runId' | 'rating' | 'reason'> & { groupBy?: FeedbackGroupBy }): Promise<FeedbackStats>;
  feedbackDigest(options: DigestOptions): Promise<string>;
  digest(options: DigestOptions): Promise<string>;
  exportScenarioCandidates(options?: ExportOptions): Promise<ScenarioCandidate[]>;
}
export class FeedbackError extends Error { code: 'invalid' | 'not_found' | 'unauthorized'; status: number }
export const RATINGS: readonly Rating[];
export const FEEDBACK_REASONS: readonly string[];
export function createFeedback(options: FeedbackOptions): FeedbackService;
export function createMemoryFeedbackStore(): FeedbackStore;
export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export function createPostgresFeedbackStore(db: Queryable, options?: { table?: string }): FeedbackStore;
export function postgresFeedbackSchema(options?: { table?: string }): string;
export function scrubPersonalData(text: string, who?: { userId?: string; tenantId?: string | null }): string;
export function toAgentScenarios(candidates: ScenarioCandidate[], options?: { fixtures?: Record<string, (args: any, context: any) => unknown> }): Array<{ id: string; question: string; tools: any[]; expect: { tools: string[]; content: Array<string | RegExp> } }>;
export const REASON_HINTS: Readonly<Record<string, string>>;
/** Structural express types: no @types/express needed. */
export interface FeedbackRouterOptions {
  feedback: FeedbackService;
  identify(req: any): { userId: string; tenantId?: string | null } | null | undefined | Promise<{ userId: string; tenantId?: string | null } | null | undefined>;
  /** Return the run only if it belongs to the person; falsy answers 404. May carry `agent` and `mode`. */
  resolveRun(req: any, runId: string, identity: { userId: string; tenantId?: string | null }): Promise<({ agent?: string; mode?: string } & Record<string, unknown>) | null | undefined | false> | ({ agent?: string; mode?: string } & Record<string, unknown>) | null | undefined | false;
  express?: any; maxBodyBytes?: number;
}
export function createFeedbackRouter(options: FeedbackRouterOptions): any;
