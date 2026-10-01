export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
/** « HH:MM » ; « 24:00 » accepté en fin de plage. */
export type WallTime = string;
export type TimeRange = [WallTime, WallTime] | { start: WallTime; end: WallTime };
export type Instant = Date | string | number;

export type ResourceException =
  | { date: string; closed: true; reason?: string }
  /** Horaires spéciaux ce jour-là : remplacent ceux de la semaine (et ouvrent un jour férié). */
  | { date: string; intervals: TimeRange[]; reason?: string }
  /** Période fermée, bornes incluses (congés). */
  | { from: string; to: string; closed?: true; reason?: string };

export interface Resource {
  id: string;
  /** Fuseau IANA : 'Africa/Kinshasa', 'Africa/Lubumbashi', 'Europe/Paris'… */
  timeZone: string;
  weekly?: Partial<Record<Weekday, TimeRange[]>>;
  exceptions?: ResourceException[];
  /** Places en même temps (1 par défaut). */
  capacity?: number;
  /** Code pays ISO : ses jours fériés ferment la ressource. */
  country?: string;
  /** false : la ressource travaille les jours fériés. */
  holidays?: boolean;
}

export interface Service {
  id?: string | null;
  /** Durée de la prestation, en minutes. */
  duration: number;
  bufferBefore?: number;
  bufferAfter?: number;
  /** Écart entre deux débuts de créneau, en minutes (la durée par défaut). */
  step?: number;
  /** Préavis minimal, en minutes. */
  minNotice?: number;
  /** Horizon maximal, en jours (60 par défaut). */
  horizon?: number;
}

export interface BusyBlock {
  resourceId: string;
  start: Instant;
  end: Instant;
}

export type BookingStatus = 'confirmed' | 'cancelled';

export interface Booking {
  id: string;
  resourceIds: string[];
  start: string;
  end: string;
  bufferBefore: number;
  bufferAfter: number;
  seats: number;
  status: BookingStatus;
  serviceId: string | null;
  data: unknown;
  history: Array<{ start: string; end: string; resourceIds: string[]; movedAt: string }>;
  cancelReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SlotMode = 'each' | 'any' | 'all';

export interface ZonedTime {
  date: string;
  time: string;
  offset: string;
}

export interface Slot {
  start: string;
  end: string;
  resourceIds: string[];
  /** Places encore libres (somme en mode any, minimum en mode all). */
  available: number;
  /** Heure murale dans le fuseau d'affichage. */
  local: ZonedTime;
}

export type HolidayCalendars = Record<string, (year: number) => Array<{ date: string; id?: string; name?: string }>>;

export interface ComputeSlotsInput {
  resources: Resource[];
  service: Service;
  from: Instant;
  to: Instant;
  now?: Instant;
  bookings?: Array<Pick<Booking, 'resourceIds' | 'start' | 'end'> & Partial<Booking>>;
  busy?: BusyBlock[];
  mode?: SlotMode;
  seats?: number;
  timeZone?: string;
  calendars?: HolidayCalendars;
}

export function computeSlots(input: ComputeSlotsInput): Slot[];

/* ---------- Stockage ---------- */

export interface BookingTransaction {
  listBookings(resourceId: string, from: string, to: string): Promise<Booking[]>;
  getBooking(id: string): Promise<Booking | null>;
  insert(booking: Booking): Promise<void>;
  update(id: string, patch: Partial<Booking>): Promise<void>;
}

export interface BookingStore {
  listBookings(resourceId: string, from: string, to: string): Promise<Booking[]>;
  getBooking(id: string): Promise<Booking | null>;
  /** Exécute `work` en exclusivité sur ces ressources ; rien n'est écrit s'il lève. */
  transaction<T>(resourceIds: string[], work: (tx: BookingTransaction) => Promise<T>): Promise<T>;
}

export function assertBookingStore<T extends BookingStore>(store: T): T;
export function createMemoryBookingStore(): BookingStore;
export function createPostgresBookingStore(options: {
  pool: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }>; connect(): Promise<any> };
  prefix?: string;
}): BookingStore;
export function createMongoBookingStore(options: {
  db: { collection(name: string): any };
  prefix?: string;
  leaseMs?: number;
  waitMs?: number;
}): BookingStore;

/* ---------- Service ---------- */

export type BookingErrorCode = 'SLOT_TAKEN' | 'SLOT_UNAVAILABLE' | 'BOOKING_NOT_FOUND' | 'BOOKING_CANCELLED' | 'RESOURCE_NOT_FOUND';

export class BookingError extends Error {
  constructor(code: BookingErrorCode, message: string);
  name: 'BookingError';
  code: BookingErrorCode;
}

export interface BookingServiceOptions {
  store: BookingStore;
  resources: Resource[] | ((id: string) => Resource | null | undefined | Promise<Resource | null | undefined>);
  services?: Record<string, Service>;
  now?: () => Instant;
  calendars?: HolidayCalendars;
  generateId?: () => string;
}

export interface BookRequest {
  /** Toutes ces ressources ensemble. */
  resourceIds?: string[];
  /** La première libre, dans l'ordre. */
  anyOf?: string[];
  service: Service | string;
  start: Instant;
  seats?: number;
  data?: unknown;
  busy?: BusyBlock[];
}

export interface BookingService {
  getSlots(input: {
    resourceIds: string[];
    service: Service | string;
    from: Instant;
    to: Instant;
    mode?: SlotMode;
    seats?: number;
    busy?: BusyBlock[];
    timeZone?: string;
  }): Promise<Slot[]>;
  book(request: BookRequest): Promise<Booking>;
  cancel(id: string, options?: { reason?: string | null }): Promise<Booking>;
  reschedule(id: string, options: { start: Instant; resourceIds?: string[]; service?: Service | string; busy?: BusyBlock[] }): Promise<Booking>;
  getBooking(id: string): Promise<Booking | null>;
}

export function createBookingService(options: BookingServiceOptions): BookingService;

/* ---------- Jours fériés et heures ---------- */

export function getPublicHolidays(country: string, year: number, calendars?: HolidayCalendars): Array<{ date: string; id?: string; name?: string }>;
export function easterSunday(year: number): string;
export const HOLIDAY_COUNTRIES: string[];
export function wallTimeToISO(date: string, time: WallTime, timeZone: string): string;
export function toZoned(instant: Instant, timeZone: string): ZonedTime;
export function offsetMinutes(instant: Instant, timeZone: string): number;
