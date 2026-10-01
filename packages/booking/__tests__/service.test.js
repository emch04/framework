const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { newDb } = require('pg-mem');
const { Pool } = require('pg');
const {
  createBookingService,
  createMemoryBookingStore,
  createPostgresBookingStore,
  createMongoBookingStore,
  BookingError,
  wallTimeToISO
} = require('../src');

/* Barber Clean, lundi 29 juin 2026 à Kinshasa : deux barbiers, une salle de 3 places. */
const KIN = 'Africa/Kinshasa';
const lundi = (heure) => wallTimeToISO('2026-06-29', heure, KIN);
const RESSOURCES = [
  { id: 'barbier-1', timeZone: KIN, weekly: { monday: [['09:00', '12:00']] } },
  { id: 'barbier-2', timeZone: KIN, weekly: { monday: [['09:00', '12:00']] } },
  { id: 'fauteuil-1', timeZone: KIN, weekly: { monday: [['09:00', '18:00']] } },
  { id: 'salle', timeZone: KIN, capacity: 3, weekly: { monday: [['09:00', '12:00']] } }
];
const SERVICES = {
  coupe: { duration: 30, bufferAfter: 10, step: 15 },
  atelier: { duration: 60 }
};
const NOW = '2026-06-28T12:00:00Z';

let mongo;
let connexion;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connexion = await mongoose.createConnection(mongo.getUri()).asPromise();
}, 180000);
afterAll(async () => {
  await connexion?.close();
  await mongo?.stop();
});

/* PostgreSQL réel : seulement si ASTRATRA_TEST_PG_URL pointe vers une base
   jetable. pg-mem ne verrouille rien : on n'y vérifie pas la concurrence. */
const PG_URL = process.env.ASTRATRA_TEST_PG_URL;
let poolReel;
afterAll(async () => {
  if (!poolReel) return;
  await poolReel.query('DROP TABLE IF EXISTS essai_bookings, essai_locks');
  await poolReel.end();
});

const STORES = {
  mémoire: { creer: async () => createMemoryBookingStore(), concurrence: true },
  'postgres (pg-mem)': {
    creer: async () => createPostgresBookingStore({ pool: new (newDb().adapters.createPg().Pool)() }),
    concurrence: false
  },
  mongo: {
    creer: async () => {
      await connexion.dropDatabase();
      return createMongoBookingStore({ db: connexion });
    },
    concurrence: true
  },
  ...(PG_URL && {
    'postgres réel': {
      creer: async () => {
        poolReel ||= new Pool({ connectionString: PG_URL, max: 20 });
        await poolReel.query('DROP TABLE IF EXISTS essai_bookings, essai_locks');
        return createPostgresBookingStore({ pool: poolReel, prefix: 'essai_' });
      },
      concurrence: true
    }
  })
};

describe.each(Object.keys(STORES))('réservation, stockage %s', (nom) => {
  let service;
  let horloge;
  beforeEach(async () => {
    horloge = NOW;
    let n = 0;
    service = createBookingService({
      store: await STORES[nom].creer(),
      resources: RESSOURCES,
      services: SERVICES,
      now: () => horloge,
      generateId: () => `rdv-${++n}`
    });
  });

  test('réserver un créneau proposé ; il disparaît des créneaux', async () => {
    const avant = await service.getSlots({ resourceIds: ['barbier-1'], service: 'coupe', from: lundi('09:00'), to: lundi('12:00') });
    expect(avant.map((c) => c.local.time)).toContain('10:00');

    const rdv = await service.book({ resourceIds: ['barbier-1'], service: 'coupe', start: lundi('10:00'), data: { client: 'c-42' } });
    expect(rdv).toMatchObject({
      id: 'rdv-1', resourceIds: ['barbier-1'], start: '2026-06-29T09:00:00.000Z', end: '2026-06-29T09:30:00.000Z',
      bufferAfter: 10, seats: 1, status: 'confirmed', serviceId: 'coupe', data: { client: 'c-42' }
    });
    expect(await service.getBooking('rdv-1')).toMatchObject({ status: 'confirmed', data: { client: 'c-42' } });

    const apres = (await service.getSlots({ resourceIds: ['barbier-1'], service: 'coupe', from: lundi('09:00'), to: lundi('12:00') })).map((c) => c.local.time);
    // Pris : 10:00–10:30 puis 10 min de nettoyage, soit 10:00–10:40. Un nouveau
    // client à 09:30 finirait son propre nettoyage à 10:10 : refusé. 10:45 passe.
    expect(apres).toEqual(['09:00', '09:15', '10:45', '11:00', '11:15', '11:30']);
  });

  test('double réservation séquentielle refusée : SLOT_TAKEN', async () => {
    await service.book({ resourceIds: ['barbier-1'], service: 'coupe', start: lundi('10:00') });
    await expect(service.book({ resourceIds: ['barbier-1'], service: 'coupe', start: lundi('10:15') }))
      .rejects.toMatchObject({ name: 'BookingError', code: 'SLOT_TAKEN' });
  });

  test('hors horaires, hors grille ou dans le passé : SLOT_UNAVAILABLE', async () => {
    for (const start of [lundi('13:00'), lundi('10:07'), '2026-06-22T09:00:00Z']) {
      await expect(service.book({ resourceIds: ['barbier-1'], service: 'coupe', start })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    }
  });

  (STORES[nom].concurrence ? test : test.skip)('vingt réservations simultanées du même créneau : une seule passe', async () => {
    const essais = await Promise.allSettled(
      Array.from({ length: 20 }, () => service.book({ resourceIds: ['barbier-1'], service: 'coupe', start: lundi('11:00') }))
    );
    const reussies = essais.filter((e) => e.status === 'fulfilled');
    expect(reussies).toHaveLength(1);
    expect(essais.filter((e) => e.status === 'rejected').every((e) => e.reason.code === 'SLOT_TAKEN')).toBe(true);
  }, 30000);

  (STORES[nom].concurrence ? test : test.skip)('capacité 3 sous concurrence : exactement trois places vendues', async () => {
    const essais = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.book({ resourceIds: ['salle'], service: 'atelier', start: lundi('09:00') }))
    );
    expect(essais.filter((e) => e.status === 'fulfilled')).toHaveLength(3);
  }, 30000);

  test('capacité : places restantes, demande de plusieurs places, annulation qui libère', async () => {
    const creneau = async () => (await service.getSlots({ resourceIds: ['salle'], service: 'atelier', from: lundi('09:00'), to: lundi('10:00') }))[0];
    expect((await creneau()).available).toBe(3);
    const a = await service.book({ resourceIds: ['salle'], service: 'atelier', start: lundi('09:00'), seats: 2 });
    expect((await creneau()).available).toBe(1);
    await expect(service.book({ resourceIds: ['salle'], service: 'atelier', start: lundi('09:00'), seats: 2 })).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    await service.book({ resourceIds: ['salle'], service: 'atelier', start: lundi('09:00') });
    expect(await creneau()).toBeUndefined();

    const annule = await service.cancel(a.id, { reason: 'client malade' });
    expect(annule).toMatchObject({ status: 'cancelled', cancelReason: 'client malade' });
    expect((await service.cancel(a.id)).cancelReason).toBe('client malade'); // deux fois : rien ne change
    expect((await creneau()).available).toBe(2);
  });

  test('coiffeur ET fauteuil ensemble ; n’importe quel coiffeur (anyOf)', async () => {
    const duo = await service.book({ resourceIds: ['barbier-1', 'fauteuil-1'], service: 'coupe', start: lundi('09:00') });
    expect(duo.resourceIds).toEqual(['barbier-1', 'fauteuil-1']);
    // Le fauteuil est pris : barbier-2 seul passe, mais pas avec ce fauteuil.
    await expect(service.book({ resourceIds: ['barbier-2', 'fauteuil-1'], service: 'coupe', start: lundi('09:00') })).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    const libre = await service.book({ anyOf: ['barbier-1', 'barbier-2'], service: 'coupe', start: lundi('09:00') });
    expect(libre.resourceIds).toEqual(['barbier-2']);
    await expect(service.book({ anyOf: ['barbier-1', 'barbier-2'], service: 'coupe', start: lundi('09:00') })).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
  });

  test('report : vers un créneau qui chevauche l’ancien, refus vers un créneau pris, historique gardé', async () => {
    const a = await service.book({ resourceIds: ['barbier-1'], service: 'coupe', start: lundi('10:00') });
    await service.book({ resourceIds: ['barbier-1'], service: 'coupe', start: lundi('11:00') });

    horloge = '2026-06-28T13:00:00Z';
    const deplace = await service.reschedule(a.id, { start: lundi('10:15') });
    expect(deplace).toMatchObject({ start: '2026-06-29T09:15:00.000Z', end: '2026-06-29T09:45:00.000Z' });
    expect(deplace.history).toEqual([{ start: '2026-06-29T09:00:00.000Z', end: '2026-06-29T09:30:00.000Z', resourceIds: ['barbier-1'], movedAt: '2026-06-28T13:00:00.000Z' }]);
    expect(await service.getBooking(a.id)).toMatchObject({ start: '2026-06-29T09:15:00.000Z', history: [expect.any(Object)] });

    await expect(service.reschedule(a.id, { start: lundi('10:45') })).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    const ailleurs = await service.reschedule(a.id, { start: lundi('11:00'), resourceIds: ['barbier-2'] });
    expect(ailleurs.resourceIds).toEqual(['barbier-2']);
    // L'ancien créneau sur barbier-1 est libéré.
    const libres = (await service.getSlots({ resourceIds: ['barbier-1'], service: 'coupe', from: lundi('09:00'), to: lundi('12:00') })).map((c) => c.local.time);
    expect(libres).toContain('10:15');

    await service.cancel(a.id);
    await expect(service.reschedule(a.id, { start: lundi('09:00') })).rejects.toMatchObject({ code: 'BOOKING_CANCELLED' });
    await expect(service.cancel('inconnu')).rejects.toBeInstanceOf(BookingError);
  });
});

test('le verrou mémoire ne bloque pas deux ressources différentes', async () => {
  const store = createMemoryBookingStore();
  const ordre = [];
  let libererA;
  const a = store.transaction(['a'], () => new Promise((resolve) => { libererA = resolve; ordre.push('a-début'); }));
  await new Promise((r) => setImmediate(r));
  await store.transaction(['b'], async () => { ordre.push('b'); });
  libererA();
  await a;
  expect(ordre).toEqual(['a-début', 'b']);
});

test('un travail qui lève n’écrit rien', async () => {
  const store = createMemoryBookingStore();
  await expect(store.transaction(['a'], async (tx) => {
    await tx.insert({ id: 'x', resourceIds: ['a'], start: '2026-06-29T08:00:00.000Z', end: '2026-06-29T09:00:00.000Z', status: 'confirmed' });
    throw new Error('échec après écriture');
  })).rejects.toThrow('échec');
  expect(await store.getBooking('x')).toBeNull();
});
