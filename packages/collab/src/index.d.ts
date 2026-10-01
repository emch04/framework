import type { Server, Hocuspocus, Extension as HocuspocusExtension } from '@hocuspocus/server';
import type { HocuspocusProvider, HocuspocusProviderConfiguration } from '@hocuspocus/provider';
import type { AnyExtension, Editor, EditorOptions, JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import type * as Y from 'yjs';

/* ---------- Persistance ---------- */

export type VersionKind = 'manual' | 'backup' | (string & {});

export interface VersionMeta {
  id: string;
  documentName: string;
  label: string | null;
  author: string | null;
  kind: VersionKind;
  /** Taille de l'instantané, en octets. */
  size: number;
  /** ISO 8601. */
  createdAt: string;
}

export interface StoredVersion extends VersionMeta {
  /** Instantané Yjs complet (`Y.encodeStateAsUpdate`). */
  state: Uint8Array;
}

export interface CollabPersistence {
  load(documentName: string): Promise<Uint8Array | null>;
  store(documentName: string, state: Uint8Array, info: { size: number; updatedAt: string }): Promise<void>;
  saveVersion(documentName: string, version: StoredVersion): Promise<void>;
  /** La plus récente d'abord, sans les instantanés. */
  listVersions(documentName: string): Promise<VersionMeta[]>;
  getVersion(documentName: string, versionId: string): Promise<StoredVersion | null>;
}

export function assertPersistence<T extends CollabPersistence>(persistence: T): T;
export function createMemoryPersistence(): CollabPersistence;

export interface PostgresLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}
export function createPostgresPersistence(options: {
  pool: PostgresLike;
  documentsTable?: string;
  versionsTable?: string;
}): CollabPersistence;

export interface MongoDbLike {
  collection(name: string): any;
}
export function createMongoPersistence(options: {
  db: MongoDbLike;
  documentsCollection?: string;
  versionsCollection?: string;
}): CollabPersistence;

/* ---------- Serveur ---------- */

export type CollabAccess = 'write' | 'read' | 'none';

export interface AuthenticateRequest {
  token: string;
  documentName: string;
  headers: Headers;
  parameters: URLSearchParams;
}

export type AuthenticateDecision =
  | CollabAccess
  | boolean
  | null
  | undefined
  | { access: CollabAccess; user?: unknown; context?: Record<string, unknown> };

export interface CollabLimits {
  /** Taille maximale d'un document (état Yjs), 5 Mio par défaut. */
  maxDocumentBytes?: number;
  /** Taille maximale d'un message reçu, 1 Mio par défaut. */
  maxMessageBytes?: number;
}

export interface CollabServerOptions {
  authenticate(request: AuthenticateRequest): AuthenticateDecision | Promise<AuthenticateDecision>;
  persistence?: CollabPersistence;
  limits?: CollabLimits;
  /** Fragments Yjs restaurés avec une version (`['default']`). */
  fields?: string[];
  debounce?: number;
  maxDebounce?: number;
  port?: number;
  address?: string;
  quiet?: boolean;
  stopOnSignals?: boolean;
  extensions?: HocuspocusExtension[];
  backupLabel?(version: VersionMeta): string;
}

export interface CollabServer {
  server: Server;
  hocuspocus: Hocuspocus;
  limits: Required<CollabLimits>;
  listen(port?: number): Promise<{ port: number; url: string }>;
  destroy(): Promise<void>;
  createVersion(documentName: string, options?: { label?: string | null; author?: string | null; kind?: VersionKind }): Promise<VersionMeta>;
  listVersions(documentName: string): Promise<VersionMeta[]>;
  restoreVersion(documentName: string, versionId: string, options?: { author?: string | null }): Promise<{ restoredFrom: VersionMeta; backup: VersionMeta }>;
  getDocumentState(documentName: string): Promise<Uint8Array | null>;
}

export function createCollabServer(options: CollabServerOptions): CollabServer;

/* ---------- Conversions ---------- */

export const DEFAULT_FIELD: 'default';
export function defaultExtensions(): AnyExtension[];

export type ConvertSource = Y.Doc | Uint8Array | JSONContent;

export interface ConverterOptions {
  extensions?: AnyExtension[];
  field?: string;
}

export interface Converter {
  schema: Schema;
  field: string;
  toJSON(source: ConvertSource): JSONContent;
  fromJSON(json: JSONContent): Y.Doc;
  toMarkdown(source: ConvertSource): string;
  markdownToJSON(markdown: string): JSONContent;
  fromMarkdown(markdown: string): Y.Doc;
  toHTML(source: ConvertSource): string;
  toText(source: ConvertSource): string;
  encodeState(doc: Y.Doc): Uint8Array;
}

export function createConverter(options?: ConverterOptions): Converter;

/* ---------- Client ---------- */

export type CollabProviderOptions = Omit<Partial<HocuspocusProviderConfiguration>, 'onAuthenticated' | 'onSynced'> & {
  url: string;
  name: string;
  token?: string | (() => string) | (() => Promise<string>);
  document?: Y.Doc;
  onAuthenticated?(scope: 'read-write' | 'readonly'): void;
  onDenied?(reason: string): void;
  onSynced?(state: boolean): void;
  /** Coupure pour une limite de taille : la reconnexion est arrêtée. */
  onLimitExceeded?(reason: string): void;
};

export function createCollabProvider(options: CollabProviderOptions): HocuspocusProvider;

export interface CollabEditorOptions {
  provider?: HocuspocusProvider;
  url?: string;
  name?: string;
  token?: CollabProviderOptions['token'];
  element?: Element | null;
  extensions?: AnyExtension[];
  field?: string;
  editable?: boolean;
  editorOptions?: Partial<Omit<EditorOptions, 'element' | 'extensions' | 'editable'>>;
  onAuthenticated?: CollabProviderOptions['onAuthenticated'];
  onDenied?: CollabProviderOptions['onDenied'];
  onSynced?: CollabProviderOptions['onSynced'];
  onLimitExceeded?: CollabProviderOptions['onLimitExceeded'];
}

export interface CollabEditor {
  editor: Editor;
  provider: HocuspocusProvider;
  document: Y.Doc;
  destroy(): void;
}

export function createCollabEditor(options: CollabEditorOptions): CollabEditor;
