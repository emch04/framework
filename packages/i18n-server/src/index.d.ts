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

/* ─────────────────────── The language of a recipient ─────────────────────── */

export interface RecipientLanguage {
  languages: string[];
  defaultLanguage: string;
  /**
   * The mail choice first (unless it is the "follow" value), then the interface
   * fields in order, then the request header, then the default. Always one of
   * `languages`.
   */
  languageOf(recipient: unknown, req?: RequestLike | null): string;
  /** What a settings endpoint should accept: the "follow" value plus every language. */
  choices: string[];
  isChoice(value: unknown): boolean;
  /** Top-level fields a reload must select for languageOf to see anything. */
  fields: string[];
}

export function createRecipientLanguage(options: {
  languages: string[];
  defaultLanguage?: string;
  /** Default 'emailLang'. Dotted paths allowed. */
  mailField?: string;
  /** Default ['lang']. Dotted paths allowed. */
  interfaceFields?: string[];
  /** The mail choice meaning "follow the interface". Default 'auto'. */
  followValue?: string;
}): RecipientLanguage;

export interface RecipientReloader<Account extends object = Record<string, unknown>> {
  /**
   * Never throws. Returns the stored account over the partial (the store wins),
   * the partial alone when the account cannot be read, or null.
   */
  reload(ref: string | number | ({ id?: unknown; _id?: unknown } & Record<string, unknown>) | null | undefined, context?: unknown): Promise<Account | Record<string, unknown> | null>;
  fields: string[];
}

export function createRecipientReloader<Account extends object = Record<string, unknown>>(options: {
  load: (id: unknown, fields: string[], context: unknown) => Promise<Account | null | undefined> | Account | null | undefined;
  fields?: string[];
  /** Its fields are always added to the selection. */
  language?: Pick<RecipientLanguage, 'fields'>;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
}): RecipientReloader<Account>;

/* ───────────────────────────── Source audits ───────────────────────────── */

export interface DuplicateKeysReport {
  /** Every direct key of the object, in source order. */
  keys: Array<{ key: string; line: number }>;
  duplicates: Array<{ key: string; lines: number[] }>;
}

/** Keys written more than once in one object literal — JavaScript keeps the last silently. */
export function findDuplicateKeys(source: string, options?: { start?: string | RegExp }): DuplicateKeysReport;

export interface HardcodedSubject {
  line: number;
  callee: string;
  literal: string;
}

export function findHardcodedSubjects(source: string, options: {
  /** The send function as written: 'sendEmail', 'mailer.send'. */
  callee: string;
  /** Which argument holds the subject or the message object. Default 0. */
  argument?: number;
  /** When that argument is an object literal, the property holding the subject. */
  property?: string;
  /** What makes a literal "written text". Default: any letter. */
  test?: RegExp | ((text: string) => boolean);
  /** A call whose text matches one of these is skipped. */
  ignore?: RegExp[];
}): HardcodedSubject[];

export function scanSourceTree<Finding extends object>(options: {
  root: string;
  inspect: (source: string, file: string) => Finding[] | null | undefined;
  extensions?: string[];
  /** Directory names, file names, or paths relative to root. */
  ignore?: string[];
}): Array<Finding & { file: string }>;

/* ──────────────────────────── Language leaks ──────────────────────────── */

export interface LanguageLeakFinding {
  part: string;
  /** The language the match belongs to; null for a missing <html lang>. */
  language: string | null;
  match: string;
}

export interface LanguageLeakResult {
  clean: boolean;
  findings: LanguageLeakFinding[];
}

export interface LanguageLeakCheck {
  inspect(mail: string | { subject?: string; text?: string; html?: string; [part: string]: string | undefined }, expected: string): LanguageLeakResult;
  describe(result: LanguageLeakResult): string[];
  languages: string[];
}

export function createLanguageLeakCheck(options: {
  /** Words that exist only in each language — pronouns and greetings are the reliable ones. */
  markers: Record<string, Array<string | RegExp>>;
  requireHtmlLang?: boolean;
}): LanguageLeakCheck;

/** What a person reads in an HTML mail: no styles, scripts, comments or tags. */
export function visibleText(html: unknown): string;
/** The `lang` of the `<html>` element, lower-cased, or null. */
export function htmlLanguage(html: unknown): string | null;
