export type Awaitable<T> = T | Promise<T>;

export interface MongoConnectionLike {
  models: Record<string, unknown>;
  model(name: string, schema: unknown, collection?: string): unknown;
  close(): Awaitable<void>;
  asPromise?(): Promise<unknown>;
}

export interface MongoStoreOptions {
  connection?: MongoConnectionLike;
  uri?: string;
  connectionOptions?: Record<string, unknown>;
  collection?: string;
}

export interface MongoUsersStoreOptions extends MongoStoreOptions {
  uniqueEmail?: boolean;
}

export interface MongoUser {
  id: string;
  email?: string;
  role?: string;
  [key: string]: unknown;
}

export interface MongoUserBase {
  id: string;
  email?: string;
  role?: string;
}

export interface UsersListOptions {
  role?: string;
  limit?: number;
  offset?: number;
}

export interface MongoUsersStore<TUser extends MongoUserBase = MongoUser> {
  findByEmail(email: string): Promise<TUser | null>;
  findById(id: string): Promise<TUser | null>;
  create(userData: Partial<TUser> & Record<string, unknown>): Promise<TUser>;
  list(options?: UsersListOptions): Promise<TUser[]>;
  update(id: string, patch: Partial<TUser> & Record<string, unknown>): Promise<TUser | null>;
  disconnect(): Promise<void>;
}

export interface MongoSettingsStore<TSettings extends object = Record<string, unknown>> {
  get<TKey extends keyof TSettings & string>(key: TKey): Promise<TSettings[TKey] | null>;
  get(key: string): Promise<unknown | null>;
  set<TKey extends keyof TSettings & string>(key: TKey, value: TSettings[TKey]): Promise<void>;
  set(key: string, value: unknown): Promise<void>;
  getAll(): Promise<Partial<TSettings>>;
  disconnect(): Promise<void>;
}

export function createMongoUsersStore<TUser extends MongoUserBase = MongoUser>(options: MongoUsersStoreOptions): MongoUsersStore<TUser>;
export function createMongoSettingsStore<TSettings extends object = Record<string, unknown>>(options: MongoStoreOptions): MongoSettingsStore<TSettings>;
