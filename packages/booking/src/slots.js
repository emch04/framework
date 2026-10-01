/**
 * Calcul des créneaux libres, sans base de données : on lui donne les
 * ressources, la prestation, les rendez-vous déjà pris et l'instant présent,
 * il rend les créneaux réservables.
 *
 * Une ressource est ce qui se réserve : une personne, une salle, un siège de
 * barbier. Elle a ses horaires hebdomadaires en heure murale DE SON fuseau,
 * ses exceptions (congés, horaires spéciaux), son pays (jours fériés) et sa
 * capacité (nombre de places en même temps).
 *
 * Règles :
 *  1. La prestation elle-même doit tenir dans une plage d'ouverture. Les
 *     tampons avant/après ne servent qu'à écarter les autres rendez-vous :
 *     un nettoyage de 10 min après le dernier client peut déborder l'horaire.
 *  2. Deux rendez-vous se gênent si leurs plages TAMPONS COMPRIS se
 *     chevauchent ; chacun garde les tampons de sa propre prestation.
 *  3. Un créneau est réservable s'il reste au moins `seats` places sur toute
 *     sa durée (tampons compris).
 *  4. Préavis : le créneau commence au plus tôt `minNotice` minutes après
 *     maintenant. Horizon : il commence au plus tard `horizon` jours après.
 *  5. Priorité des règles d'un jour : exception datée > congés (période) >
 *     jour férié > horaires de la semaine. Une exception datée avec des
 *     horaires ouvre donc un jour férié ou un dimanche.
 */

const {
  MINUTE,
  JOURS,
  assertTimeZone,
  parseTime,
  addDays,
  weekday,
  zonedToInstant,
  toZoned,
  toInstant,
  verifierDate
} = require('./time');
const { getPublicHolidays } = require('./holidays');

const JOUR_MS = 24 * 60 * MINUTE;
const MODES = ['each', 'any', 'all'];

function entierPositif(valeur, champ, { zero = false } = {}) {
  if (!Number.isInteger(valeur) || valeur < (zero ? 0 : 1)) {
    throw new TypeError(`${champ} doit être un entier ${zero ? 'positif ou nul' : 'strictement positif'} (reçu : ${valeur}).`);
  }
  return valeur;
}

/** Plages « HH:MM » → minutes, triées et fusionnées quand elles se touchent. */
function normaliserPlages(plages, champ) {
  const liste = (plages || []).map((plage) => {
    const [debut, fin] = Array.isArray(plage) ? plage : [plage.start, plage.end];
    const d = parseTime(debut);
    const f = parseTime(fin);
    if (f <= d) throw new TypeError(`${champ} : la plage ${debut}–${fin} finit avant de commencer.`);
    return [d, f];
  });
  return fusionner(liste);
}

function fusionner(plages) {
  const liste = plages.map((plage) => [...plage]).sort((a, b) => a[0] - b[0]);
  const fusion = [];
  for (const plage of liste) {
    const derniere = fusion[fusion.length - 1];
    if (derniere && plage[0] <= derniere[1]) derniere[1] = Math.max(derniere[1], plage[1]);
    else fusion.push(plage);
  }
  return fusion;
}

function normaliserRessource(ressource) {
  if (!ressource || ressource.id == null) throw new TypeError('Chaque ressource doit avoir un id.');
  assertTimeZone(ressource.timeZone);
  const weekly = {};
  for (const [jour, plages] of Object.entries(ressource.weekly || {})) {
    if (!JOURS.includes(jour)) throw new TypeError(`Jour inconnu dans weekly : ${jour} (attendu : ${JOURS.join(', ')}).`);
    weekly[jour] = normaliserPlages(plages, `weekly.${jour}`);
  }
  const exceptions = (ressource.exceptions || []).map((exception) => {
    if (exception.date) verifierDate(exception.date);
    else if (exception.from && exception.to) {
      verifierDate(exception.from);
      verifierDate(exception.to);
      if (exception.intervals) throw new TypeError('Une période (from/to) ne peut que fermer : donne des horaires date par date.');
    } else throw new TypeError('Une exception a soit `date`, soit `from` et `to`.');
    return {
      ...exception,
      closed: exception.closed === true || !exception.intervals,
      intervals: exception.intervals ? normaliserPlages(exception.intervals, `exception ${exception.date}`) : []
    };
  });
  return {
    id: String(ressource.id),
    timeZone: ressource.timeZone,
    capacity: entierPositif(ressource.capacity ?? 1, 'capacity'),
    country: ressource.country ? String(ressource.country).toUpperCase() : null,
    holidays: ressource.holidays !== false,
    weekly,
    exceptions
  };
}

function normaliserService(service = {}) {
  const duration = entierPositif(service.duration, 'service.duration');
  return {
    id: service.id ?? null,
    duration,
    bufferBefore: entierPositif(service.bufferBefore ?? 0, 'service.bufferBefore', { zero: true }),
    bufferAfter: entierPositif(service.bufferAfter ?? 0, 'service.bufferAfter', { zero: true }),
    step: entierPositif(service.step ?? duration, 'service.step'),
    minNotice: entierPositif(service.minNotice ?? 0, 'service.minNotice', { zero: true }),
    horizon: entierPositif(service.horizon ?? 60, 'service.horizon')
  };
}

/** Plages d'ouverture d'une ressource pour une date civile, en minutes murales. */
function plagesDuJour(ressource, date, feries) {
  const datees = ressource.exceptions.filter((e) => e.date === date);
  if (datees.length) {
    if (datees.some((e) => e.closed)) return [];
    return fusionner(datees.flatMap((e) => e.intervals));
  }
  if (ressource.exceptions.some((e) => e.from && e.from <= date && date <= e.to)) return [];
  if (ressource.holidays && ressource.country && feries(ressource.country, date)) return [];
  return ressource.weekly[weekday(date)] || [];
}

/** Cache des jours fériés (pays, année) pour un calcul. */
function creerFeries(calendars) {
  const cache = new Map();
  return (pays, date) => {
    const annee = Number(date.slice(0, 4));
    const cle = `${pays}:${annee}`;
    if (!cache.has(cle)) cache.set(cle, new Set(getPublicHolidays(pays, annee, calendars).map((f) => f.date)));
    return cache.get(cle).has(date);
  };
}

/**
 * Occupations d'une ressource : rendez-vous actifs (tampons compris) et
 * indisponibilités externes, qui prennent toute la capacité.
 */
function occupations(ressourceId, bookings, busy) {
  const liste = [];
  for (const b of bookings) {
    if (b.status === 'cancelled' || !(b.resourceIds || []).map(String).includes(ressourceId)) continue;
    liste.push({
      debut: toInstant(b.start, 'booking.start') - (b.bufferBefore || 0) * MINUTE,
      fin: toInstant(b.end, 'booking.end') + (b.bufferAfter || 0) * MINUTE,
      places: b.seats ?? 1
    });
  }
  for (const bloc of busy) {
    if (String(bloc.resourceId) !== ressourceId) continue;
    liste.push({ debut: toInstant(bloc.start, 'busy.start'), fin: toInstant(bloc.end, 'busy.end'), places: Infinity });
  }
  return liste;
}

/** Places prises au pire moment de [debut, fin). */
function placesPrises(liste, debut, fin) {
  const chevauchent = liste.filter((o) => o.debut < fin && debut < o.fin);
  let maximum = 0;
  for (const point of [debut, ...chevauchent.map((o) => o.debut).filter((t) => t > debut)]) {
    const total = chevauchent.reduce((somme, o) => (o.debut <= point && point < o.fin ? somme + o.places : somme), 0);
    maximum = Math.max(maximum, total);
  }
  return maximum;
}

/** Créneaux d'UNE ressource : [{ debut, fin, restantes }]. */
function creneauxRessource(ressource, service, fenetre, bookings, busy, feries) {
  const occupe = occupations(ressource.id, bookings, busy);
  const resultat = [];
  // Une journée de marge de chaque côté : un fuseau éloigné décale les dates.
  let date = toZoned(fenetre.debut - JOUR_MS, ressource.timeZone).date;
  const derniere = toZoned(fenetre.fin + JOUR_MS, ressource.timeZone).date;
  for (; date <= derniere; date = addDays(date, 1)) {
    for (const [debutMin, finMin] of plagesDuJour(ressource, date, feries)) {
      const ouverture = zonedToInstant(date, debutMin, ressource.timeZone);
      const fermeture = zonedToInstant(date, finMin, ressource.timeZone);
      for (let debut = ouverture; debut + service.duration * MINUTE <= fermeture; debut += service.step * MINUTE) {
        if (debut < fenetre.debut || debut >= fenetre.fin) continue;
        const fin = debut + service.duration * MINUTE;
        const prises = placesPrises(occupe, debut - service.bufferBefore * MINUTE, fin + service.bufferAfter * MINUTE);
        resultat.push({ debut, fin, restantes: Math.max(0, ressource.capacity - prises) });
      }
    }
  }
  return resultat;
}

/**
 * @param {object} input
 * @param {Array} input.resources
 * @param {object} input.service { duration, bufferBefore?, bufferAfter?, step?, minNotice?, horizon? }
 * @param {Date|string|number} input.from  début de la fenêtre demandée.
 * @param {Date|string|number} input.to    fin de la fenêtre (exclue).
 * @param {Date|string|number} [input.now]
 * @param {Array} [input.bookings]  rendez-vous connus { resourceIds, start, end, bufferBefore, bufferAfter, seats, status }.
 * @param {Array} [input.busy]      indisponibilités externes { resourceId, start, end }.
 * @param {'each'|'any'|'all'} [input.mode='each']
 *        each : un créneau par ressource ; any : au moins une ressource libre ;
 *        all : toutes les ressources libres en même temps (coiffeur ET fauteuil).
 * @param {number} [input.seats=1] places demandées.
 * @param {string} [input.timeZone] fuseau d'affichage de `local` (celui de la 1re ressource sinon).
 * @param {object} [input.calendars] calendriers de jours fériés en plus.
 */
function computeSlots({
  resources,
  service,
  from,
  to,
  now = Date.now(),
  bookings = [],
  busy = [],
  mode = 'each',
  seats = 1,
  timeZone,
  calendars
} = {}) {
  if (!Array.isArray(resources) || !resources.length) throw new TypeError('resources doit contenir au moins une ressource.');
  if (!MODES.includes(mode)) throw new TypeError(`mode inconnu : ${mode} (attendu : ${MODES.join(', ')}).`);
  entierPositif(seats, 'seats');
  const ressources = resources.map(normaliserRessource);
  const prestation = normaliserService(service);
  const affichage = timeZone || ressources[0].timeZone;
  assertTimeZone(affichage);

  const maintenant = toInstant(now, 'now');
  const fenetre = {
    debut: Math.max(toInstant(from, 'from'), maintenant + prestation.minNotice * MINUTE),
    fin: Math.min(toInstant(to, 'to'), maintenant + prestation.horizon * JOUR_MS)
  };
  if (fenetre.fin <= fenetre.debut) return [];

  const feries = creerFeries(calendars);
  const parDebut = new Map();
  for (const ressource of ressources) {
    for (const c of creneauxRessource(ressource, prestation, fenetre, bookings, busy, feries)) {
      if (!parDebut.has(c.debut)) parDebut.set(c.debut, []);
      parDebut.get(c.debut).push({ ressource: ressource.id, fin: c.fin, restantes: c.restantes });
    }
  }

  const sortie = (debut, fin, resourceIds, available) => ({
    start: new Date(debut).toISOString(),
    end: new Date(fin).toISOString(),
    resourceIds,
    available,
    local: toZoned(debut, affichage)
  });

  const creneaux = [];
  for (const debut of [...parDebut.keys()].sort((a, b) => a - b)) {
    const libres = parDebut.get(debut).filter((c) => c.restantes >= seats);
    if (mode === 'each') {
      for (const c of libres) creneaux.push(sortie(debut, c.fin, [c.ressource], c.restantes));
    } else if (mode === 'any' && libres.length) {
      creneaux.push(sortie(debut, libres[0].fin, libres.map((c) => c.ressource), libres.reduce((s, c) => s + c.restantes, 0)));
    } else if (mode === 'all' && libres.length === ressources.length) {
      creneaux.push(sortie(debut, libres[0].fin, libres.map((c) => c.ressource), Math.min(...libres.map((c) => c.restantes))));
    }
  }
  return creneaux;
}

module.exports = { computeSlots, normaliserRessource, normaliserService };
