export class UnsafeTestDatabaseError extends Error {
  code: 'UNSAFE_TEST_DATABASE';
  reason: 'NODE_ENV_PRODUCTION' | 'INVALID_URI' | 'MANAGED_PROVIDER' | 'SRV_CLUSTER' | 'PRODUCTION_NAME' | 'REMOTE_HOST' | 'REMOTE_NOT_MARKED_TEST' | 'SAME_AS_CONFIGURED';
}
export interface DatabaseUriInfo { scheme: string; engine: 'mongodb' | 'postgres'; hosts: string[]; database: string }
export interface GuardOptions {
  env?: Record<string, string | undefined>;
  /** Hôtes distants explicitement acceptés (la base doit alors porter « test » dans son nom). */
  allowRemoteHosts?: string[];
}
export function parseDatabaseUri(uri: string): DatabaseUriInfo | null;
/** Lance UnsafeTestDatabaseError si l'URI ressemble à de la production. */
export function assertSafeTestDatabaseUri(uri: string, options?: GuardOptions): DatabaseUriInfo;
export function isSafeTestDatabaseUri(uri: string, options?: GuardOptions): boolean;

export const MONGO_IMAGE: string;
export const POSTGRES_IMAGE: string;
export interface TestDatabase {
  engine: 'mongodb' | 'postgres';
  uri: string;
  container: unknown;
  stop(): Promise<void>;
}
export interface StartOptions {
  image?: string;
  database?: string;
  env?: Record<string, string | undefined>;
  loader?: (moduleName: string) => unknown;
}
export function isDockerAvailable(options?: { spawn?: (command: string, args: string[], options: object) => { status: number | null } }): boolean;
export function startMongo(options?: StartOptions): Promise<TestDatabase>;
export function startPostgres(options?: StartOptions): Promise<TestDatabase>;
export function mongoUri(rawUri: string, database: string): string;

export interface FakeAddress { street: string; district: string | null; city: string; region: string; postalCode: string | null; country: string; countryCode: string }
export interface FakePerson {
  id: string; firstName: string; lastName: string; fullName: string; sex: 'female' | 'male';
  birthDate: string; email: string; phone: string; address: FakeAddress;
}
export interface FakeOrganization { id: string; name: string; phone: string; email: string; address: FakeAddress }
export interface FakeData {
  country: string;
  seed: number;
  /** Instance faker sous-jacente, déjà graînée, pour les besoins non couverts. */
  faker: import('@faker-js/faker').Faker;
  person(options?: { sex?: 'female' | 'male'; minAge?: number; maxAge?: number }): FakePerson;
  phone(): string;
  address(): FakeAddress;
  organization(): FakeOrganization;
  people(count: number, options?: { sex?: 'female' | 'male'; minAge?: number; maxAge?: number }): FakePerson[];
  list<T>(count: number, factory: (index: number) => T): T[];
}
export function createFakeData(options?: { country?: string; seed?: number }): FakeData;
export function supportedCountries(): string[];
export const EMAIL_DOMAIN: string;
