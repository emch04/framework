/**
 * Montants et devises.
 *
 * Un montant est TOUJOURS un entier dans la plus petite unité de sa devise
 * (centimes pour USD, EUR et CDF, unité pour XAF et XOF qui n'ont pas de
 * subdivision en usage). Aucun nombre à virgule ne participe à un calcul :
 * les taux sont lus comme des fractions exactes (BigInt) et l'arrondi n'a
 * lieu qu'une fois, à la fin, au demi le plus éloigné de zéro.
 */

/** Nombre de décimales de chaque devise (ISO 4217). */
const DECIMALES_PAR_DEFAUT = Object.freeze({ CDF: 2, USD: 2, EUR: 2, XAF: 0, XOF: 0 });

class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function verifierMontant(valeur, champ) {
  if (!Number.isSafeInteger(valeur)) {
    throw new LedgerError('INVALID_AMOUNT', `${champ} doit être un entier en plus petite unité (centimes), reçu : ${valeur}.`);
  }
  return valeur;
}

function verifierDate(date, champ = 'date') {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new LedgerError('INVALID_DATE', `${champ} doit être un jour civil AAAA-MM-JJ (reçu : ${date}).`);
  }
  return date;
}

/**
 * Lit un taux décimal ("2850.5", "0.00035", 655.957) en fraction exacte.
 * Un taux de change nul n'a pas de sens ; un taux de taxe nul, si.
 */
function lireTaux(taux, { zeroAllowed = false } = {}) {
  const texte = typeof taux === 'number' ? String(taux) : taux;
  if (typeof texte !== 'string' || !/^\d+(\.\d+)?$/.test(texte)) {
    throw new LedgerError('INVALID_RATE', `Taux invalide : ${taux}. Attendu : un décimal positif, par exemple "2850.50".`);
  }
  const [entier, decimales = ''] = texte.split('.');
  const num = BigInt(entier + decimales);
  if (num === 0n && !zeroAllowed) throw new LedgerError('INVALID_RATE', 'Un taux de change ne peut pas être nul.');
  return { num, den: 10n ** BigInt(decimales.length) };
}

/** Division entière arrondie au demi le plus éloigné de zéro. */
function diviserArrondi(num, den) {
  const negatif = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const quotient = (2n * a + b) / (2n * b);
  return negatif ? -quotient : quotient;
}

function enNombre(grand, champ) {
  const nombre = Number(grand);
  if (!Number.isSafeInteger(nombre)) throw new LedgerError('AMOUNT_OVERFLOW', `${champ} dépasse la précision sûre.`);
  return nombre;
}

/**
 * Registre des devises connues. `extra` ajoute ou remplace des devises :
 * { GBP: 2, JPY: 0 }.
 */
function createCurrencies(extra = {}) {
  const decimales = { ...DECIMALES_PAR_DEFAUT, ...extra };
  for (const [code, nombre] of Object.entries(decimales)) {
    if (!/^[A-Z]{3}$/.test(code) || !Number.isInteger(nombre) || nombre < 0 || nombre > 4) {
      throw new LedgerError('INVALID_CURRENCY', `Devise invalide : ${code} (${nombre} décimales).`);
    }
  }
  return {
    codes: () => Object.keys(decimales),
    decimals(code) {
      if (!(code in decimales)) throw new LedgerError('UNKNOWN_CURRENCY', `Devise inconnue : ${code}.`);
      return decimales[code];
    },
    /** Montant en plus petite unité → texte lisible "1234.56". */
    format(montant, code) {
      verifierMontant(montant, 'montant');
      const d = this.decimals(code);
      const signe = montant < 0 ? '-' : '';
      const absolu = String(Math.abs(montant)).padStart(d + 1, '0');
      return d === 0 ? `${signe}${absolu}` : `${signe}${absolu.slice(0, -d)}.${absolu.slice(-d)}`;
    }
  };
}

/**
 * Table des taux. Un taux se lit « 1 unité de `from` vaut `rate` unités de
 * `to` » et vaut à partir de sa date, jusqu'au taux suivant. Le taux inverse
 * est déduit exactement (fraction retournée), jamais arrondi.
 */
function createRateTable(options = {}) {
  const parPaire = new Map();

  function ajouter({ from, to, date, rate }) {
    verifierDate(date, 'date du taux');
    if (from === to) throw new LedgerError('INVALID_RATE', 'Un taux relie deux devises différentes.');
    const cle = `${from}>${to}`;
    const liste = parPaire.get(cle) || [];
    const fraction = lireTaux(rate);
    const existant = liste.findIndex((t) => t.date === date);
    if (existant >= 0) liste[existant] = { date, ...fraction, rate: String(rate) };
    else liste.push({ date, ...fraction, rate: String(rate) });
    liste.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    parPaire.set(cle, liste);
  }

  function dernier(liste, date) {
    let trouve = null;
    for (const taux of liste || []) {
      if (taux.date <= date) trouve = taux;
      else break;
    }
    return trouve;
  }

  for (const taux of options.rates || []) ajouter(taux);

  return {
    add(taux) {
      ajouter(taux);
      return this;
    },
    /**
     * Taux applicable à une date : le plus récent en vigueur, direct ou
     * inverse. Retourne une fraction { num, den, date, inverted }.
     */
    rateAt(from, to, date) {
      verifierDate(date);
      if (from === to) return { num: 1n, den: 1n, date, inverted: false };
      const direct = dernier(parPaire.get(`${from}>${to}`), date);
      const inverse = dernier(parPaire.get(`${to}>${from}`), date);
      const choisi = direct && (!inverse || direct.date >= inverse.date) ? direct : inverse;
      if (!choisi) {
        throw new LedgerError('RATE_NOT_FOUND', `Aucun taux ${from} → ${to} en vigueur au ${date}.`, { from, to, date });
      }
      return choisi === direct
        ? { num: choisi.num, den: choisi.den, date: choisi.date, inverted: false }
        : { num: choisi.den, den: choisi.num, date: choisi.date, inverted: true };
    }
  };
}

/**
 * Convertit un montant en plus petite unité d'une devise vers une autre.
 * `taux` est une fraction { num, den } (1 from = num/den to).
 */
function convertir(montant, taux, decimalesSource, decimalesCible) {
  verifierMontant(montant, 'montant');
  let num = BigInt(montant) * taux.num;
  let den = taux.den;
  const ecart = decimalesCible - decimalesSource;
  if (ecart > 0) num *= 10n ** BigInt(ecart);
  else if (ecart < 0) den *= 10n ** BigInt(-ecart);
  return enNombre(diviserArrondi(num, den), 'montant converti');
}

/** Somme sûre : refuse de dépasser la précision entière des nombres JavaScript. */
function somme(valeurs) {
  let total = 0;
  for (const valeur of valeurs) {
    total += valeur;
    if (!Number.isSafeInteger(total)) throw new LedgerError('AMOUNT_OVERFLOW', 'Total hors de la précision sûre.');
  }
  return total;
}

module.exports = {
  LedgerError,
  DECIMALES_PAR_DEFAUT,
  createCurrencies,
  createRateTable,
  convertir,
  diviserArrondi,
  lireTaux,
  somme,
  verifierDate,
  verifierMontant
};
