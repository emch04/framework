/**
 * Service de réservation : créneaux, réservation atomique, annulation, report.
 *
 * Toute écriture passe par `store.transaction` : on relit les rendez-vous de
 * la ressource SOUS VERROU, on recalcule le créneau demandé avec les mêmes
 * règles que `getSlots`, puis on écrit. Deux personnes qui cliquent sur le
 * même dernier créneau à la même milliseconde : une seule l'obtient, l'autre
 * reçoit `SLOT_TAKEN`.
 */

const { randomUUID } = require('node:crypto');
const { computeSlots, normaliserService } = require('./slots');
const { assertBookingStore } = require('./stores');
const { toInstant, MINUTE } = require('./time');

const JOUR_MS = 24 * 60 * MINUTE;

class BookingError extends Error {
  /**
   * @param {'SLOT_TAKEN'|'SLOT_UNAVAILABLE'|'BOOKING_NOT_FOUND'|'BOOKING_CANCELLED'|'RESOURCE_NOT_FOUND'} code
   */
  constructor(code, message) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {object} options.store voir `stores.js`.
 * @param {Array|((id: string) => object|null|Promise<object|null>)} options.resources
 *        les ressources, ou une fonction qui en rend une par id.
 * @param {Record<string, object>} [options.services] prestations par id, si
 *        l'application préfère passer `service: 'coupe'` plutôt que l'objet.
 * @param {() => Date|number} [options.now]
 * @param {object} [options.calendars] calendriers de jours fériés en plus.
 */
function createBookingService({ store, resources, services = {}, now = () => Date.now(), calendars, generateId = randomUUID } = {}) {
  assertBookingStore(store);
  const parId = Array.isArray(resources) ? new Map(resources.map((r) => [String(r.id), r])) : null;
  if (!parId && typeof resources !== 'function') throw new TypeError('resources doit être une liste ou une fonction.');

  async function ressource(id) {
    const trouvee = parId ? parId.get(String(id)) : await resources(String(id));
    if (!trouvee) throw new BookingError('RESOURCE_NOT_FOUND', `Ressource inconnue : ${id}`);
    return trouvee;
  }

  function prestation(service) {
    const objet = typeof service === 'string' ? services[service] && { id: service, ...services[service] } : service;
    if (!objet) throw new TypeError(`Prestation inconnue : ${service} (passe l’objet, ou déclare-la dans services).`);
    return objet;
  }

  /* Les rendez-vous qui peuvent gêner [from, to) : on élargit d'une journée
     pour attraper ceux dont seuls les tampons débordent. */
  async function rendezVous(source, resourceIds, from, to) {
    const debut = new Date(from - JOUR_MS).toISOString();
    const fin = new Date(to + JOUR_MS).toISOString();
    const vus = new Map();
    for (const id of resourceIds) {
      for (const b of await source.listBookings(id, debut, fin)) vus.set(b.id, b);
    }
    return [...vus.values()];
  }

  async function getSlots({ resourceIds, service, from, to, mode = 'each', seats = 1, busy = [], timeZone } = {}) {
    if (!Array.isArray(resourceIds) || !resourceIds.length) throw new TypeError('resourceIds doit contenir au moins un id.');
    const liste = await Promise.all(resourceIds.map(ressource));
    const debut = toInstant(from, 'from');
    const fin = toInstant(to, 'to');
    return computeSlots({
      resources: liste,
      service: prestation(service),
      from: debut,
      to: fin,
      now: now(),
      bookings: await rendezVous(store, resourceIds, debut, fin),
      busy,
      mode,
      seats,
      timeZone,
      calendars
    });
  }

  /**
   * Vérifie, sous verrou, qu'un créneau est encore offert à `start` pour
   * TOUTES ces ressources. `ignorer` : le rendez-vous qu'on déplace.
   */
  async function verifier(tx, liste, service, start, seats, busy, ignorer) {
    const instant = toInstant(start, 'start');
    const tous = (await rendezVous(tx, liste.map((r) => r.id), instant, instant + 1)).filter((b) => b.id !== ignorer);
    const options = { resources: liste, service, from: instant, to: instant + 1, now: now(), busy, mode: 'all', seats, calendars };
    const creneau = computeSlots({ ...options, bookings: tous }).find((c) => Date.parse(c.start) === instant);
    if (creneau) return creneau;
    // Le créneau existe-t-il sans les autres rendez-vous ? Alors il vient d'être pris.
    const sansRdv = computeSlots({ ...options, bookings: [] }).some((c) => Date.parse(c.start) === instant);
    throw sansRdv
      ? new BookingError('SLOT_TAKEN', 'Ce créneau vient d’être réservé.')
      : new BookingError('SLOT_UNAVAILABLE', 'Ce créneau n’est pas proposé (horaires, préavis, horizon ou fermeture).');
  }

  async function reserverSur(resourceIds, { service, start, seats = 1, data = null, busy = [] }) {
    const liste = await Promise.all(resourceIds.map(ressource));
    const objet = prestation(service);
    const regles = normaliserService(objet);
    return store.transaction(resourceIds, async (tx) => {
      const creneau = await verifier(tx, liste, objet, start, seats, busy);
      const horodatage = new Date(toInstant(now(), 'now')).toISOString();
      const booking = {
        id: generateId(),
        resourceIds: resourceIds.map(String),
        start: creneau.start,
        end: creneau.end,
        bufferBefore: regles.bufferBefore,
        bufferAfter: regles.bufferAfter,
        seats,
        status: 'confirmed',
        serviceId: regles.id,
        data,
        history: [],
        cancelReason: null,
        cancelledAt: null,
        createdAt: horodatage,
        updatedAt: horodatage
      };
      await tx.insert(booking);
      return booking;
    });
  }

  /**
   * Réserve. `resourceIds` : toutes ces ressources ensemble (coiffeur ET
   * fauteuil). `anyOf` : la première ressource libre de la liste, dans
   * l'ordre (« n'importe quel coiffeur »).
   */
  async function book({ resourceIds, anyOf, ...demande } = {}) {
    if (anyOf) {
      if (!Array.isArray(anyOf) || !anyOf.length) throw new TypeError('anyOf doit contenir au moins un id.');
      let derniere;
      for (const id of anyOf) {
        try {
          return await reserverSur([id], demande);
        } catch (erreur) {
          if (!(erreur instanceof BookingError) || !['SLOT_TAKEN', 'SLOT_UNAVAILABLE'].includes(erreur.code)) throw erreur;
          // Une ressource prise prime sur une ressource fermée pour expliquer le refus.
          if (!derniere || erreur.code === 'SLOT_TAKEN') derniere = erreur;
        }
      }
      throw derniere;
    }
    if (!Array.isArray(resourceIds) || !resourceIds.length) throw new TypeError('resourceIds ou anyOf est requis.');
    return reserverSur(resourceIds, demande);
  }

  async function existant(id) {
    const booking = await store.getBooking(id);
    if (!booking) throw new BookingError('BOOKING_NOT_FOUND', `Rendez-vous introuvable : ${id}`);
    return booking;
  }

  /** Annule : les places se libèrent aussitôt. Annuler deux fois ne change rien. */
  async function cancel(id, { reason = null } = {}) {
    const { resourceIds } = await existant(id);
    return store.transaction(resourceIds, async (tx) => {
      const booking = await tx.getBooking(id);
      if (booking.status === 'cancelled') return booking;
      const horodatage = new Date(toInstant(now(), 'now')).toISOString();
      const patch = { status: 'cancelled', cancelReason: reason, cancelledAt: horodatage, updatedAt: horodatage };
      await tx.update(id, patch);
      return { ...booking, ...patch };
    });
  }

  /**
   * Reporte à `start`, sur les mêmes ressources ou d'autres. Le rendez-vous
   * ne se gêne pas lui-même : passer de 10:00 à 10:15 sur une prestation
   * d'une heure est permis. L'ancien horaire part dans `history`.
   */
  async function reschedule(id, { start, resourceIds, service, busy = [] } = {}) {
    const actuel = await existant(id);
    const cibles = (resourceIds || actuel.resourceIds).map(String);
    const liste = await Promise.all(cibles.map(ressource));
    // La grille des créneaux dépend de la prestation (pas, tampons) : on la
    // reprend telle quelle, sans la deviner depuis le rendez-vous.
    const objet = prestation(service ?? actuel.serviceId);
    const regles = normaliserService(objet);
    return store.transaction([...actuel.resourceIds, ...cibles], async (tx) => {
      const booking = await tx.getBooking(id);
      if (booking.status === 'cancelled') throw new BookingError('BOOKING_CANCELLED', 'Un rendez-vous annulé ne se reporte pas.');
      const creneau = await verifier(tx, liste, objet, start, booking.seats, busy, id);
      const horodatage = new Date(toInstant(now(), 'now')).toISOString();
      const patch = {
        resourceIds: cibles,
        start: creneau.start,
        end: creneau.end,
        bufferBefore: regles.bufferBefore,
        bufferAfter: regles.bufferAfter,
        serviceId: regles.id,
        history: [...(booking.history || []), { start: booking.start, end: booking.end, resourceIds: booking.resourceIds, movedAt: horodatage }],
        updatedAt: horodatage
      };
      await tx.update(id, patch);
      return { ...booking, ...patch };
    });
  }

  return { getSlots, book, cancel, reschedule, getBooking: (id) => store.getBooking(id) };
}

module.exports = { createBookingService, BookingError };
