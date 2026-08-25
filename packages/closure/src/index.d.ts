export type Awaitable<T> = T | Promise<T>;

export interface ClosureCheck {
  id: string;
  label?: string;
  /** Forbids closing while open. Non-blocking items only demand to be SEEN. */
  blocking?: boolean;
}

export interface ChecklistItem {
  id: string;
  label: string;
  remaining: number;
  blocking: boolean;
  done: boolean;
  /** Open but non-blocking: closing requires an explicit tick from a person. */
  needsAcknowledgement: boolean;
}

export interface Checklist {
  items: ChecklistItem[];
  blocking: number;
  remaining: number;
  canClose: boolean;
}

export type CloseDecision =
  | { ok: true }
  | { ok: false; reason: 'blocking' }
  | { ok: false; reason: 'unacknowledged'; unseen: string[] };

export interface ClosureChecklist {
  /** Pure: your controller counts, this judges. */
  build(counts?: Record<string, number>): Checklist;
  canCloseWith(checklist: Checklist | null | undefined, acknowledged?: string[]): CloseDecision;
  checks: string[];
}

export function createClosureChecklist(checks: ClosureCheck[]): ClosureChecklist;

export interface Scrubber {
  /** Shallow: a row's secrets live at its top level. */
  scrub<T>(document: T): T;
  banned: string[];
}

export function createScrubber(options?: {
  /** Replaces the default list. */
  neverExport?: string[];
  /** Added to it. */
  alsoNever?: string[];
}): Scrubber;

export const DEFAULT_NEVER_EXPORT: string[];

export interface ArchiveSection<Scope = unknown> {
  name: string;
  read: (scope: Scope) => Awaitable<Array<Record<string, unknown>> | null | undefined>;
}

export interface Archive {
  builtAt: string;
  sections: Record<string, Array<Record<string, unknown>>>;
  counts: Record<string, number>;
  /** A failed section is NAMED — an archive silently missing one looks complete and is not. */
  failed: Array<{ name: string; reason: string }>;
  complete: boolean;
}

export interface ArchiveBuilder<Scope = unknown> {
  build(scope: Scope): Promise<Archive>;
  sections: string[];
}

export function createArchiveBuilder<Scope = unknown>(options: {
  sections: Array<ArchiveSection<Scope>>;
  scrubber?: Scrubber;
  logger?: { error?(message: string): void };
}): ArchiveBuilder<Scope>;
