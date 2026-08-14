export type Awaitable<T> = T | Promise<T>;

export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  connect(): Promise<PgClientLike>;
  end(): Awaitable<void>;
}

export interface PostgresStoreOptions {
  pool?: PgPoolLike;
  connectionString?: string;
}

export interface PostgresUsersStoreOptions extends PostgresStoreOptions {
  usersTable?: string;
  uniqueEmail?: boolean;
}

export interface PostgresSettingsStoreOptions extends PostgresStoreOptions {
  settingsTable?: string;
}

export interface PostgresUser {
  id: string;
  email?: string;
  role?: string;
  [key: string]: unknown;
}

export interface PostgresUserBase {
  id: string;
  email?: string;
  role?: string;
}

export interface UsersListOptions {
  role?: string;
  limit?: number;
  offset?: number;
}

export interface PostgresUsersStore<TUser extends PostgresUserBase = PostgresUser> {
  findByEmail(email: string): Promise<TUser | null>;
  findById(id: string): Promise<TUser | null>;
  create(userData: Partial<TUser> & Record<string, unknown>): Promise<TUser>;
  list(options?: UsersListOptions): Promise<TUser[]>;
  count(options?: Pick<UsersListOptions, 'role'>): Promise<number>;
  countByRole(): Promise<Record<string, number>>;
  update(id: string, patch: Partial<TUser> & Record<string, unknown>): Promise<TUser | null>;
  disconnect(): Promise<void>;
}

export interface PostgresSettingsStore<TSettings extends object = Record<string, unknown>> {
  get<TKey extends keyof TSettings & string>(key: TKey): Promise<TSettings[TKey] | null>;
  get(key: string): Promise<unknown | null>;
  set<TKey extends keyof TSettings & string>(key: TKey, value: TSettings[TKey]): Promise<TSettings[TKey]>;
  set(key: string, value: unknown): Promise<unknown>;
  getAll(): Promise<Partial<TSettings>>;
  disconnect(): Promise<void>;
}

export function createPostgresUsersStore<TUser extends PostgresUserBase = PostgresUser>(options: PostgresUsersStoreOptions): PostgresUsersStore<TUser>;
export function createPostgresSettingsStore<TSettings extends object = Record<string, unknown>>(options: PostgresSettingsStoreOptions): PostgresSettingsStore<TSettings>;

export interface PostgresMigration {
  id: string;
  up(client: PgClientLike): Awaitable<unknown>;
}

export interface PostgresMigrationRunnerOptions {
  pool: PgPoolLike;
  /** Defaults to "astratra_migrations". */
  migrationsTable?: string;
}

export interface PostgresMigrationRunner {
  /** IDs already recorded as applied, oldest first. */
  appliedIds(): Promise<string[]>;
  /** Runs whichever of the given migrations aren't applied yet, in order — each inside its own transaction, rolled back on failure. */
  run(migrations: PostgresMigration[]): Promise<{ applied: string[] }>;
}

export function createPostgresMigrationRunner(options: PostgresMigrationRunnerOptions): PostgresMigrationRunner;
