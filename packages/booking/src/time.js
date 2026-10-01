/**
 * Heures murales et fuseaux horaires, sans dépendance : tout passe par
 * `Intl.DateTimeFormat`, qui embarque la base des fuseaux de l'environnement.
 *
 * Une disponibilité s'écrit en heure murale (« 09:00 à Kinshasa ») ; un
 * rendez-vous se stocke en instant absolu (UTC). La conversion de l'une à
 * l'autre change selon la date, à cause des changements d'heure : 09:00 à
 * Paris vaut 08:00 UTC en hiver et 07:00 UTC en été.
 */

const MINUTE = 60 * 1000;
const JOUR_MS = 24 * 60 * MINUTE;
const JOURS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const formateurs = new Map();
function formateur(timeZone) {
  let f = formateurs.get(timeZone);
  if (!f) {
    // Lève une RangeError pour un fuseau inconnu : voulu, l'erreur arrive tôt.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formateurs.set(timeZone, f);
  }
  return f;
}

function assertTimeZone(timeZone) {
  try {
    formateur(timeZone);
  } catch {
    throw new RangeError(`Fuseau horaire inconnu : ${timeZone}`);
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Champs de l'heure murale d'un instant dans un fuseau. */
function wallParts(instant, timeZone) {
  const valeurs = {};
  for (const { type, value } of formateur(timeZone).formatToParts(new Date(instant))) valeurs[type] = value;
  return {
    year: Number(valeurs.year),
    month: Number(valeurs.month),
    day: Number(valeurs.day),
    hour: Number(valeurs.hour),
    minute: Number(valeurs.minute),
    second: Number(valeurs.second)
  };
}

/** Décalage du fuseau à cet instant, en minutes (Kinshasa : +60, Paris l'été : +120). */
function offsetMinutes(instant, timeZone) {
  const ms = Math.floor(new Date(instant).getTime() / 1000) * 1000;
  const p = wallParts(ms, timeZone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / MINUTE);
}

function verifierDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new TypeError(`Date attendue au format AAAA-MM-JJ (reçu : ${date}).`);
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new TypeError(`Date inexistante : ${date}`);
  return [y, m, d];
}

/** « HH:MM » → minutes depuis minuit ; « 24:00 » accepté (fin de journée). */
function parseTime(time) {
  const trouve = /^(\d{2}):(\d{2})$/.exec(String(time));
  if (!trouve) throw new TypeError(`Heure attendue au format HH:MM (reçu : ${time}).`);
  const minutes = Number(trouve[1]) * 60 + Number(trouve[2]);
  if (Number(trouve[2]) > 59 || minutes > 24 * 60) throw new TypeError(`Heure invalide : ${time}`);
  return minutes;
}

function addDays(date, jours) {
  const [y, m, d] = verifierDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + jours));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Jour de la semaine d'une date civile : 'monday'…'sunday'. */
function weekday(date) {
  const [y, m, d] = verifierDate(date);
  return JOURS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * Heure murale → instant UTC (millisecondes).
 *
 * Deux cas particuliers aux changements d'heure, tranchés comme le fait
 * Temporal (« compatible ») :
 *  - heure inexistante (le printemps saute de 02:00 à 03:00) : on avance
 *    d'autant, 02:30 devient 03:30 ;
 *  - heure ambiguë (l'automne repasse deux fois par 02:30) : la première.
 */
function zonedToInstant(date, minutes, timeZone) {
  const [y, m, d] = verifierDate(date);
  const naif = Date.UTC(y, m - 1, d) + minutes * MINUTE;
  const avant = offsetMinutes(naif - JOUR_MS / 2, timeZone);
  const apres = offsetMinutes(naif + JOUR_MS / 2, timeZone);
  const valides = [...new Set([avant, apres])]
    .map((decalage) => naif - decalage * MINUTE)
    .filter((instant) => naif - offsetMinutes(instant, timeZone) * MINUTE === instant);
  if (valides.length) return Math.min(...valides);
  return naif - avant * MINUTE;
}

/** Instant → { date: 'AAAA-MM-JJ', time: 'HH:MM', offset: '+01:00' } dans un fuseau. */
function toZoned(instant, timeZone) {
  const p = wallParts(instant, timeZone);
  const decalage = offsetMinutes(instant, timeZone);
  const signe = decalage < 0 ? '-' : '+';
  const abs = Math.abs(decalage);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    offset: `${signe}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  };
}

/** Accepte Date, nombre (ms) ou chaîne ISO ; refuse ce qui n'est pas un instant. */
function toInstant(valeur, champ = 'date') {
  const ms = valeur instanceof Date ? valeur.getTime() : typeof valeur === 'number' ? valeur : Date.parse(valeur);
  if (!Number.isFinite(ms)) throw new TypeError(`${champ} n'est pas un instant valide (reçu : ${valeur}).`);
  return ms;
}

module.exports = {
  MINUTE,
  JOURS,
  assertTimeZone,
  offsetMinutes,
  parseTime,
  addDays,
  weekday,
  zonedToInstant,
  toZoned,
  toInstant,
  verifierDate
};
