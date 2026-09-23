/**
 * Carte à quota mensuel : un abonnement qui donne droit à N passages par mois
 * calendaire. Le compteur revient à N le 1er du mois, quel que soit le jour
 * d'activation, et ce qui n'a pas été utilisé ne se reporte pas. Au-delà du
 * quota, le passage ne compte plus : il se paie normalement.
 *
 * Extrait de la carte d'abonnement de Barber Clean (23/09/2026).
 *
 * Le compteur n'est jamais stocké : il se relit dans l'historique des
 * passages. C'est ce qui rend l'annulation d'un passage sans risque, et la
 * remise à zéro du 1er sans tâche planifiée — un nouveau mois n'a simplement
 * aucun passage.
 *
 * Le mois est celui d'un fuseau horaire choisi, obligatoire : minuit passé
 * le 30 septembre à Paris, c'est encore septembre à New York. Un fuseau par
 * défaut ferait basculer des passages de mois sans que personne ne le voie.
 */

const DECISIONS = Object.freeze(['count', 'duplicate', 'exhausted', 'suspended']);

function verifierFuseau(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) {
    throw new TypeError('timeZone est obligatoire (exemple : « Europe/Paris »).');
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
  } catch {
    throw new RangeError(`Fuseau horaire inconnu : ${timeZone}`);
  }
}

/**
 * @param {object} options
 * @param {number} options.quota               passages par mois.
 * @param {string} options.timeZone            fuseau IANA du commerce (« Europe/Paris »).
 * @param {number} [options.duplicateWindowMs=120000] deux passages plus rapprochés
 *        sont un geste répété, pas deux prestations : le second demande
 *        confirmation. 0 désactive la garde.
 * @param {string} [options.qrPrefix]          préfixe du texte des QR (« BCA: »), qui
 *        permet au scanner de reconnaître la carte et de refuser les autres.
 * @param {{prefix: string, digits?: number}} [options.number]  numéro lisible de
 *        la carte (« A-000123 ») : prefix « A », digits 6.
 */
function createMonthlyPass({ quota, timeZone, duplicateWindowMs = 2 * 60 * 1000, qrPrefix, number } = {}) {
  if (!Number.isInteger(quota) || quota < 1) throw new TypeError('quota doit être un entier positif.');
  verifierFuseau(timeZone);
  if (!Number.isFinite(duplicateWindowMs) || duplicateWindowMs < 0) {
    throw new TypeError('duplicateWindowMs doit être un nombre de millisecondes positif ou nul.');
  }
  if (number && !/^[A-Z]{1,4}$/.test(String(number.prefix || ''))) {
    throw new TypeError('number.prefix doit être 1 à 4 lettres majuscules (exemple : « A »).');
  }
  const chiffres = number?.digits ?? 6;
  if (!Number.isInteger(chiffres) || chiffres < 1 || chiffres > 12) throw new TypeError('number.digits doit être un entier de 1 à 12.');

  const formatMois = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' });

  /** Le mois d'une date dans le fuseau du commerce, « 2026-09 ». */
  function monthOf(date) {
    const parties = Object.fromEntries(formatMois.formatToParts(new Date(date)).map((partie) => [partie.type, partie.value]));
    return `${parties.year}-${parties.month}`;
  }

  /** Le 1er du mois suivant, « 2026-10-01 » : le jour où le compteur revient au quota. */
  function resetsOn(month) {
    const [annee, mois] = String(month).split('-').map(Number);
    return mois === 12 ? `${annee + 1}-01-01` : `${annee}-${String(mois + 1).padStart(2, '0')}-01`;
  }

  const valides = (pass) => (pass?.uses || []).filter((use) => use && use.date && !use.cancelled);

  /**
   * @param {{status?: string, uses?: Array<{date: Date|string, cancelled?: boolean}>}} pass
   * @param {Date|string|number} [now]
   */
  function evaluate(pass, now = new Date()) {
    const month = monthOf(now);
    const utilises = Math.min(valides(pass).filter((use) => monthOf(use.date) === month).length, quota);
    return {
      month,
      used: utilises,
      remaining: quota - utilises,
      quota,
      exhausted: utilises >= quota,
      active: pass?.status === 'active',
      resetsOn: resetsOn(month),
      // Les trois derniers passages, tous mois confondus, du plus récent au plus ancien (ISO).
      recentUses: valides(pass).map((use) => new Date(use.date).toISOString()).sort().reverse().slice(0, 3)
    };
  }

  /**
   * Ce que doit faire un scan :
   *  - `suspended` : la carte n'est pas active, rien n'est compté ;
   *  - `exhausted` : le quota du mois est atteint, le passage se paie ;
   *  - `duplicate` : un passage vient d'être compté, demander confirmation
   *    (puis rappeler avec `force: true`) ;
   *  - `count` : compter le passage.
   */
  function decideScan(pass, now = new Date(), { force = false } = {}) {
    if (pass?.status !== 'active') return 'suspended';
    if (evaluate(pass, now).exhausted) return 'exhausted';
    if (!force && duplicateWindowMs > 0) {
      const dernier = Math.max(...valides(pass).map((use) => new Date(use.date).getTime()));
      if (Number.isFinite(dernier) && new Date(now).getTime() - dernier < duplicateWindowMs) return 'duplicate';
    }
    return 'count';
  }

  /* Le QR porte un jeton secret, jamais le numéro : un numéro se devine
     (A-000124 suit A-000123), un jeton non. */
  function exigerPrefixe() {
    if (!qrPrefix) throw new Error('qrPrefix n’est pas configuré.');
  }

  function qrText(token) {
    exigerPrefixe();
    return `${qrPrefix}${token}`;
  }

  /** Le jeton lu dans un QR, ou null si ce n'est pas une carte de ce programme. */
  function tokenFromQr(text) {
    exigerPrefixe();
    const valeur = String(text || '').trim();
    if (!valeur.startsWith(qrPrefix)) return null;
    const jeton = valeur.slice(qrPrefix.length);
    return /^[A-Za-z0-9_-]{16,64}$/.test(jeton) ? jeton : null;
  }

  function exigerNumero() {
    if (!number) throw new Error('number n’est pas configuré.');
  }

  /** 123 → « A-000123 ». */
  function formatNumber(n) {
    exigerNumero();
    if (!Number.isInteger(n) || n < 1 || String(n).length > chiffres) throw new RangeError(`Numéro hors limites : ${n}`);
    return `${number.prefix}-${String(n).padStart(chiffres, '0')}`;
  }

  /**
   * Le numéro tapé à la main, tel qu'on l'écrit au comptoir : « a-000901 »,
   * « A000901 », « a 901 », « 901 » donnent tous « A-000901 ». Null si ce
   * n'est pas un numéro de ce programme.
   */
  function parseNumber(input) {
    exigerNumero();
    const texte = String(input || '').toUpperCase().replace(/[\s_.]/g, '');
    const correspondance = new RegExp(`^(?:${number.prefix}-?)?(\\d{1,${chiffres}})$`).exec(texte);
    if (!correspondance || Number(correspondance[1]) === 0) return null;
    return `${number.prefix}-${correspondance[1].padStart(chiffres, '0')}`;
  }

  return { quota, timeZone, monthOf, resetsOn, evaluate, decideScan, qrText, tokenFromQr, formatNumber, parseNumber };
}

module.exports = { createMonthlyPass, SCAN_DECISIONS: DECISIONS };
