/** An express Router — opaque here, mount it with `app.use(path, router)` (same convention as @astratra/credentials). */
export type Router = unknown;

export type CheckResult = { ok: true } | { ok: false; reason: string };

export const APPLE_WWDR_G4: string;

export interface PassCertificateInfo {
  passTypeIdentifier: string | null;
  teamIdentifier: string | null;
  expiresAt: string;
  x509: unknown;
}

export function readPassCertificate(pem: string): PassCertificateInfo | null;
export function checkAppleCredentials(input: { certificate?: string; privateKey?: string }, now?: number): CheckResult;

export interface GoogleServiceAccount {
  type: 'service_account';
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

export function readGoogleServiceAccount(json: string | object): GoogleServiceAccount | null;
export function checkGoogleCredentials(input: { issuerId?: string; serviceAccount?: string }): CheckResult;
export function toHexField(text: string): string;
export function fromHexField(value: string | undefined): string | undefined;

export interface PassField {
  key: string;
  label?: string;
  value: string | number;
  textAlignment?: string;
  changeMessage?: string;
  [key: string]: unknown;
}

export interface PassContent {
  serialNumber: string;
  /** At least 16 characters (Apple requirement). */
  authenticationToken: string;
  headerFields?: PassField[];
  primaryFields?: PassField[];
  secondaryFields?: PassField[];
  auxiliaryFields?: PassField[];
  backFields?: PassField[];
  barcode?: { message: string; altText?: string; format?: string };
  images?: Record<string, Buffer>;
  /** Voided card: Apple Wallet greys it out. The only way for an issuer to retire a card already added. */
  voided?: boolean;
}

export interface ApplePassesOptions {
  certificate: string;
  privateKey: string;
  passphrase?: string;
  wwdr?: string;
  webServiceURL: string;
  organizationName: string;
  description: string;
  images?: Record<string, Buffer>;
  colors?: { foregroundColor?: string; backgroundColor?: string; labelColor?: string };
  type?: 'storeCard' | 'generic' | 'coupon' | 'eventTicket';
  logoText?: string;
}

export interface ApplePasses {
  passTypeIdentifier: string;
  teamIdentifier: string;
  expiresAt: string;
  build(card: PassContent): Buffer;
}

export function createApplePasses(options: ApplePassesOptions): ApplePasses;

export interface ApnsOptions {
  certificate: string;
  privateKey: string;
  passphrase?: string;
  passTypeIdentifier: string;
  connect?: (...args: unknown[]) => unknown;
  host?: string;
}

export function sendApplePassUpdate(pushToken: string, options: ApnsOptions): Promise<number>;

export interface Registration {
  deviceLibraryIdentifier: string;
  passTypeIdentifier: string;
  serialNumber: string;
  pushToken: string;
}

export interface RegistrationStore {
  register(registration: Registration): Promise<boolean>;
  unregister(registration: Omit<Registration, 'pushToken'>): Promise<boolean>;
  listForDevice(deviceLibraryIdentifier: string, passTypeIdentifier: string): Promise<Registration[]>;
  listForPass(passTypeIdentifier: string, serialNumber: string): Promise<Registration[]>;
  forgetPushToken(pushToken: string): Promise<void>;
  /** Deleted card: forget every device registered for it. Returns how many. */
  forgetPass(passTypeIdentifier: string, serialNumber: string): Promise<number>;
}

export function notifyApplePass(options: Omit<ApnsOptions, 'passTypeIdentifier'> & {
  registrations: RegistrationStore;
  passTypeIdentifier: string;
  serialNumber: string;
}): Promise<number>;

export function createMemoryRegistrationStore(): RegistrationStore;
export function createMongooseRegistrationStore(connection: unknown, collection?: string): RegistrationStore;

export function createAppleWebServiceRouter(options: {
  resolveConfig(): Promise<{ passTypeIdentifier: string } | null>;
  findPass(serialNumber: string): Promise<{ authenticationToken: string; updatedAt?: Date | string } | null>;
  buildPass(serialNumber: string): Promise<Buffer>;
  registrations: RegistrationStore;
  logger?: { warn(message: string): void };
}): Router;

export type GoogleKind = 'loyalty' | 'generic' | 'offer' | 'giftCard';

export interface GoogleWallet {
  classId(suffix: string): string;
  objectId(suffix: string): string;
  ensureClass(definition: { id: string; [key: string]: unknown }): Promise<string>;
  upsertObject(object: { id: string; classId: string; [key: string]: unknown }): Promise<string>;
  /** Retire a card: only `state` is sent. False when Google never had it (404). */
  deactivateObject(id: string, state?: 'INACTIVE' | 'EXPIRED'): Promise<boolean>;
  saveLink(objects: Array<{ id: string; classId: string }>, options?: { now?: Date; origins?: string[] }): string;
}

export function createGoogleWallet(options: {
  issuerId: string;
  credentials: { client_email: string; private_key: string };
  kind?: GoogleKind;
  request?: (options: Record<string, unknown>) => Promise<unknown>;
}): GoogleWallet;

export function signSaveJwt(
  payload: Record<string, unknown>,
  credentials: { client_email: string; private_key: string },
  options?: { now?: Date; origins?: string[] }
): string;
