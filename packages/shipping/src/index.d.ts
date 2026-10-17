import type { EventLog, WebhookHandler, WebhookLogger, Outcome } from '@astratra/payments';

/* ─────────────────── Errors ─────────────────── */

export const CODES: Readonly<{
  NOT_CONFIGURED: 'not_configured';
  CREDENTIALS_REFUSED: 'credentials_refused';
  UNAVAILABLE: 'unavailable';
  REJECTED: 'rejected';
  NOT_FOUND: 'not_found';
  CANCEL_REFUSED: 'cancel_refused';
  NO_METHOD: 'no_method';
  SERVICE_POINTS_UNAVAILABLE: 'service_points_unavailable';
  INVALID_INPUT: 'invalid_input';
  UNEXPECTED_RESPONSE: 'unexpected_response';
}>;
export type ShippingErrorCode = (typeof CODES)[keyof typeof CODES];

/** A stable code, an HTTP status to answer with, the provider's status — never its body nor a key. */
export class ShippingError extends Error {
  constructor(code: ShippingErrorCode, details?: { providerStatus?: number });
  code: ShippingErrorCode;
  status: number;
  providerStatus?: number;
}

/** The sentence for a code (or a ShippingError) in 'fr' or 'en'; French when the language is unknown. */
export function messageFor(codeOrError: ShippingErrorCode | string | ShippingError, language?: string): string;

/* ─────────────────── The carrier contract ─────────────────── */

export type ParcelStage = 'picked_up' | 'delivered' | 'incident';

export interface ShippingMethod {
  id: number | string;
  name: string;
  carrier: string;
  servicePointRequired: boolean;
  /** The provider's indicative price, in cents; null when unknown. */
  priceCents: number | null;
}

export interface Recipient {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  phone?: string;
  email?: string;
}

export interface Label {
  parcelId: number;
  trackingNumber: string;
  trackingUrl: string;
  carrier: string;
  service: string;
  testMode: boolean;
}

export interface ServicePoint {
  id: number;
  carrier: string;
  name: string;
  address: string;
  postalCode: string;
  city: string;
  country: string;
  openingTimes: Record<string, unknown>;
  distanceMeters: number | null;
}

export interface ParcelEvent {
  parcelId: number;
  trackingNumber: string;
  trackingUrl: string;
  /** The provider's status label. */
  message: string;
  stage: ParcelStage | null;
}

export class Carrier {
  get name(): string;
  status(): Promise<{ configured: boolean; missing: string[]; testMode?: boolean }> | { configured: boolean; missing: string[] };
  shippingMethods(query: { country: string; weightGrams: number; servicePointId?: number | string | null }): Promise<ShippingMethod[]>;
  createLabel(input: {
    orderNumber: string;
    recipient: Recipient;
    weightGrams: number;
    method: { id: number | string; name?: string; carrier?: string };
    servicePointId?: number | string | null;
  }): Promise<Label>;
  downloadLabel(input: { parcelId: number; format?: 'a4' | 'a6'; startFrom?: number }): Promise<{ content: Buffer; type: 'application/pdf' }>;
  cancelLabel(input: { parcelId: number }): Promise<{ status: 'cancelled' | 'requested' }>;
  servicePoints(query: {
    country: string;
    postalCode?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
    /** Provider carrier codes, for example ['mondial_relay', 'colissimo']; all when omitted. */
    carriers?: string[];
    radiusMeters?: number;
    limit?: number;
  }): Promise<ServicePoint[]>;
  verifySignature(rawBody: Buffer, signature: string | undefined): Promise<boolean> | boolean;
  readEvent(json: unknown): ParcelEvent | null;
}

/* ─────────────────── Sendcloud ─────────────────── */

export const SENDCLOUD_API_URL: string;
export const SENDCLOUD_SERVICE_POINTS_URL: string;

type Secret = string | (() => string | Promise<string>);

export interface SendcloudOptions {
  publicKey: Secret;
  /** Also signs the tracking webhooks. */
  secretKey: Secret;
  fetch?: typeof fetch;
  baseUrl?: string;
  servicePointsUrl?: string;
  /** Default 20 000. */
  timeoutMs?: number;
  /** Options of @astratra/resilience retry (reads only). */
  retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> };
  /** Options of @astratra/resilience createCircuitBreaker. */
  breaker?: { failureThreshold?: number; recoveryMs?: number; now?: () => number };
  /** Labels on Sendcloud's "Unstamped letter" (found by name): nothing is posted. */
  testMode?: boolean;
  /** Default 120; false disables the service point cache. */
  servicePointsCacheSeconds?: number | false;
}

export class SendcloudCarrier extends Carrier {
  constructor(options: SendcloudOptions);
  readonly testMode: boolean;
  status(): Promise<{ configured: boolean; missing: string[]; testMode: boolean }>;
  verifySignature(rawBody: Buffer, signature: string | undefined): Promise<boolean>;
}

export function createSendcloudCarrier(options: SendcloudOptions): SendcloudCarrier;

/** 'picked_up' | 'delivered' | 'incident' | null for a Sendcloud status label. */
export function classifySendcloudStatus(message: unknown): ParcelStage | null;

/* ─────────────────── Tracking webhook ─────────────────── */

export const SIGNATURE_HEADER: 'sendcloud-signature';

type ParcelHandler = (
  event: ParcelEvent,
  tools: { sideEffect<T>(label: string, fn: () => Promise<T> | T): Promise<T | null>; handled(reason?: string): Outcome; unrelated(reason?: string): Outcome; duplicate(reason?: string): Outcome }
) => Promise<Outcome | void> | Outcome | void;

/** The carrier's tracking webhook on @astratra/payments: mount it before any JSON body parser. */
export function createCarrierWebhook(options: {
  carrier: Pick<Carrier, 'verifySignature' | 'readEvent'>;
  /** Replay protection, for example createPostgresEventLog from @astratra/payments. */
  eventLog?: EventLog;
  onEvent?: ParcelHandler;
  onPickedUp?: ParcelHandler;
  onDelivered?: ParcelHandler;
  onIncident?: ParcelHandler;
  signatureHeader?: string;
  logger?: WebhookLogger;
}): WebhookHandler;
