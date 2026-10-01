import {
  computeSlots,
  createBookingService,
  createMemoryBookingStore,
  createPostgresBookingStore,
  createMongoBookingStore,
  getPublicHolidays,
  wallTimeToISO,
  toZoned,
  BookingError
} from './src';
import type { Booking, BookingStore, Resource, Slot, Service } from './src';

const barbier: Resource = {
  id: 'barbier-1',
  timeZone: 'Africa/Kinshasa',
  country: 'CD',
  weekly: { monday: [['09:00', '12:00'], { start: '14:00', end: '18:00' }] },
  exceptions: [{ date: '2026-07-01', closed: true }, { from: '2026-08-01', to: '2026-08-15' }, { date: '2026-07-05', intervals: [['10:00', '11:00']] }]
};
const coupe: Service = { id: 'coupe', duration: 30, bufferAfter: 10, step: 15, minNotice: 60, horizon: 30 };

const creneaux: Slot[] = computeSlots({ resources: [barbier], service: coupe, from: new Date(), to: '2026-07-10T00:00:00Z', mode: 'any' });
const store: BookingStore = createMemoryBookingStore();
const pg: BookingStore = createPostgresBookingStore({ pool: { query: async () => ({ rows: [] }), connect: async () => ({}) } });
const mongo: BookingStore = createMongoBookingStore({ db: { collection: () => ({}) }, leaseMs: 5000 });

const service = createBookingService({ store, resources: [barbier], services: { coupe }, now: () => new Date() });

async function parcours(): Promise<Booking> {
  const libres = await service.getSlots({ resourceIds: ['barbier-1'], service: 'coupe', from: new Date(), to: Date.now() + 86400000 });
  const rdv = await service.book({ anyOf: ['barbier-1'], service: 'coupe', start: libres[0].start, data: { client: 'c1' } });
  await service.reschedule(rdv.id, { start: wallTimeToISO('2026-06-29', '10:15', 'Africa/Kinshasa') });
  try {
    await service.book({ resourceIds: ['barbier-1'], service: coupe, start: rdv.start });
  } catch (erreur) {
    if (erreur instanceof BookingError && erreur.code === 'SLOT_TAKEN') void erreur;
  }
  return service.cancel(rdv.id, { reason: 'client absent' });
}

const feries = getPublicHolidays('CD', 2026).map((f) => f.date);
const local: string = toZoned(Date.now(), 'Europe/Paris').time;

export { creneaux, pg, mongo, parcours, feries, local };
