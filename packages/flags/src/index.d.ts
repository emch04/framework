export type FlagType = 'boolean' | 'string' | 'number' | 'json';
export type FlagValue = boolean | string | number | Record<string, unknown> | unknown[];
export interface EvaluationContext { targetingKey?: string; attributes?: Record<string, unknown> }
export type VersionOperator = { gte?: string; gt?: string; lte?: string; lt?: string; eq?: string; '>='?: string; '>'?: string; '<='?: string; '<'?: string; '=='?: string; between?: [string, string] };
export type NumericOperator = { attribute: string; gt?: number; gte?: number; lt?: number; lte?: number; '>'?: number; '>='?: number; '<'?: number; '<='?: number; between?: [number, number] };
export type TargetRule = Record<string, unknown | unknown[]> | { version: string | VersionOperator } | { number: NumericOperator } | { all: TargetRule[] } | { any: TargetRule[] };
export interface Variant { name: string; value: FlagValue; weight: number }
export interface FlagDefinition { type: FlagType; default: FlagValue; value?: FlagValue; target?: TargetRule; rollout?: number; seed?: string; namespace?: string; variants?: Variant[] }
export interface FlagRules { flags: Record<string, FlagDefinition>; [key: string]: unknown }
export interface Resolution<T> { value: T; reason: 'STATIC' | 'SPLIT' | 'DEFAULT' | 'TARGETING_MATCH' | 'TARGETING_MISMATCH' | 'FLAG_NOT_FOUND' | 'ERROR'; variant?: string; flagKey: string }
export interface RuleSource { get(): Promise<FlagRules>; set?(rules: FlagRules | string): Promise<FlagRules>; refresh?(): Promise<FlagRules>; start?(): this; stop?(): void | Promise<void> }
export interface FlagProvider { metadata: { name: string }; resolveBoolean(key: string, fallback?: boolean, context?: EvaluationContext): Promise<Resolution<boolean>>; resolveString(key: string, fallback?: string, context?: EvaluationContext): Promise<Resolution<string>>; resolveNumber(key: string, fallback?: number, context?: EvaluationContext): Promise<Resolution<number>>; resolveObject<T extends FlagValue>(key: string, fallback?: T, context?: EvaluationContext): Promise<Resolution<T>>; close(): Promise<void> }
export function fnv1a32(value: string): number;
export function bucket(seed: string, identifier: string | undefined | null): number | null;
/** Compare deux versions sémantiques. Retourne -1, 0, 1, ou null si l'une est invalide. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 | null;
export function createMemorySource(rules: FlagRules | string): RuleSource;
export function createFileSource(path: string): RuleSource;
export function createUrlSource(url: string, options?: { initial?: FlagRules | string; refreshIntervalMs?: number; timeoutMs?: number; fetch?: typeof fetch }): RuleSource;
export function createFlagProvider(options: { source: RuleSource; name?: string; onExposure?: (event: { flagKey: string; variant: string; targetingKey?: string; context: EvaluationContext }) => void | Promise<void> }): FlagProvider;
