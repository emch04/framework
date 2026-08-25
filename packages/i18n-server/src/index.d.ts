/*
 * Structural express types, declared here rather than pulled from @types/express:
 * this package has no runtime dependencies and should not force a type
 * dependency on its consumers either.
 */
export interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

export interface ResponseLike {
  json(payload: unknown): unknown;
  [key: string]: unknown;
}

export type NextFunction = (error?: unknown) => unknown;
export type RequestHandler = (req: RequestLike, res: ResponseLike, next: NextFunction) => unknown;

export interface LanguageCoverage {
  translated: number;
  total: number;
  missing: string[];
}

export interface MessageCatalog {
  languages: string[];
  defaultLanguage: string;
  supports(language: string): boolean;
  has(message: string): boolean;
  /** Returns the source sentence when it cannot translate — never blank, never a key. */
  translate<T>(message: T, language: string): T;
  coverage(): Record<string, LanguageCoverage>;
  size(): number;
}

export function createMessageCatalog(options: {
  languages: string[];
  defaultLanguage?: string;
  messages?: Record<string, Record<string, string>>;
}): MessageCatalog;

export interface LanguageResolver {
  languages: string[];
  defaultLanguage: string;
  /** Always one of `languages` — never null, never a tag you do not serve. */
  resolveLanguage(req: RequestLike): string;
}

export function createLanguageResolver(options: {
  languages: string[];
  defaultLanguage?: string;
  read?: (req: RequestLike) => string | null | undefined;
}): LanguageResolver;

export function createTranslationMiddleware(options: {
  catalog: MessageCatalog;
  resolver: LanguageResolver;
  /** Response fields to translate. Defaults to ['message']. Never the data payload. */
  fields?: string[];
  /** Request property holding the resolved language. Defaults to 'language'. */
  attach?: string;
}): RequestHandler;

export interface MessageEntry {
  file?: string;
  message: string;
}

export interface JargonFinding extends MessageEntry {
  matched: string[];
}

export interface AuditFindings {
  jargon: JargonFinding[];
  tooShort: MessageEntry[];
  clean: boolean;
}

export interface MessageAudit {
  inspect(entries?: MessageEntry[]): AuditFindings;
  describe(findings: AuditFindings): string[];
  jargon: RegExp[];
  minWords: number;
}

export function createMessageAudit(options?: {
  jargon?: RegExp[];
  minWords?: number;
  allow?: string[];
}): MessageAudit;

export function collectMessages(options: {
  root: string;
  /** Must carry the `g` flag and expose the message as capture group 1. */
  pattern: RegExp;
  extensions?: string[];
  ignore?: string[];
}): MessageEntry[];

export const DEFAULT_JARGON: RegExp[];
