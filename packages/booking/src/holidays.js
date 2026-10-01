/**
 * Jours fériés par pays (code ISO 3166-1 alpha-2).
 *
 * Ce sont des DONNÉES : chaque pays est une fonction année → liste de dates.
 * Un pays absent se fournit par l'application (`calendars`), et une liste
 * officielle qui change (un décret ajoute un jour) se corrige ici sans
 * toucher au calcul des créneaux. `name` est le nom officiel dans la langue
 * du pays, `id` une clé stable pour la traduction.
 */

const { addDays } = require('./time');

const pad = (n) => String(n).padStart(2, '0');

/** Dimanche de Pâques (calendrier grégorien, algorithme dit « anonyme »). */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31);
  const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(mois)}-${pad(jour)}`;
}

const fixe = (year, mmjj, id, name) => ({ date: `${year}-${mmjj}`, id, name });
const paques = (year, decalage, id, name) => ({ date: addDays(easterSunday(year), decalage), id, name });

const CALENDRIERS = {
  // République démocratique du Congo (liste complétée en 2023 : 6 avril et 2 août).
  CD: (year) => [
    fixe(year, '01-01', 'new-year', 'Nouvel An'),
    fixe(year, '01-04', 'independence-martyrs', 'Journée des martyrs de l’indépendance'),
    fixe(year, '01-16', 'laurent-desire-kabila', 'Journée du héros national Laurent-Désiré Kabila'),
    fixe(year, '01-17', 'patrice-lumumba', 'Journée du héros national Patrice Emery Lumumba'),
    fixe(year, '04-06', 'simon-kimbangu', 'Journée du combat de Simon Kimbangu et de la conscience africaine'),
    fixe(year, '05-01', 'labour-day', 'Fête du travail'),
    fixe(year, '05-17', 'liberation-day', 'Journée de la révolution et de la libération'),
    fixe(year, '06-30', 'independence-day', 'Fête de l’indépendance'),
    fixe(year, '08-01', 'parents-day', 'Fête des parents'),
    fixe(year, '08-02', 'genocost', 'Journée de commémoration du génocide congolais'),
    fixe(year, '12-25', 'christmas', 'Noël')
  ],
  FR: (year) => [
    fixe(year, '01-01', 'new-year', 'Jour de l’an'),
    paques(year, 1, 'easter-monday', 'Lundi de Pâques'),
    fixe(year, '05-01', 'labour-day', 'Fête du Travail'),
    fixe(year, '05-08', 'victory-1945', 'Victoire 1945'),
    paques(year, 39, 'ascension', 'Ascension'),
    paques(year, 50, 'whit-monday', 'Lundi de Pentecôte'),
    fixe(year, '07-14', 'national-day', 'Fête nationale'),
    fixe(year, '08-15', 'assumption', 'Assomption'),
    fixe(year, '11-01', 'all-saints', 'Toussaint'),
    fixe(year, '11-11', 'armistice-1918', 'Armistice 1918'),
    fixe(year, '12-25', 'christmas', 'Noël')
  ],
  BE: (year) => [
    fixe(year, '01-01', 'new-year', 'Nouvel An'),
    paques(year, 1, 'easter-monday', 'Lundi de Pâques'),
    fixe(year, '05-01', 'labour-day', 'Fête du Travail'),
    paques(year, 39, 'ascension', 'Ascension'),
    paques(year, 50, 'whit-monday', 'Lundi de Pentecôte'),
    fixe(year, '07-21', 'national-day', 'Fête nationale'),
    fixe(year, '08-15', 'assumption', 'Assomption'),
    fixe(year, '11-01', 'all-saints', 'Toussaint'),
    fixe(year, '11-11', 'armistice-1918', 'Armistice'),
    fixe(year, '12-25', 'christmas', 'Noël')
  ]
};

/**
 * @param {string} country code pays (CD, FR, BE… ou un pays de `calendars`).
 * @param {number} year
 * @param {Record<string, (year: number) => Array<{date: string, id?: string, name?: string}>>} [calendars]
 *        calendriers fournis par l'application ; ils priment sur ceux du paquet.
 */
function getPublicHolidays(country, year, calendars = {}) {
  const code = String(country).toUpperCase();
  const calendrier = calendars[code] || CALENDRIERS[code];
  if (!calendrier) throw new RangeError(`Aucun calendrier de jours fériés pour le pays ${code}.`);
  return calendrier(year).slice().sort((a, b) => a.date.localeCompare(b.date));
}

const HOLIDAY_COUNTRIES = Object.keys(CALENDRIERS);

module.exports = { getPublicHolidays, easterSunday, HOLIDAY_COUNTRIES };
