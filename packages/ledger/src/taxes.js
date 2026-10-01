/**
 * Taxes par pays, importées d'Odoo comme données (data/taxes/, LGPL-3).
 *
 * Seule la RDC (`cd`) est livrée : TVA 16 % (marchandises, services,
 * immobilisations, importations en autoliquidation) et taux 0 % (export,
 * exonéré, non imposable). Le calcul, lui, est écrit ici : base × taux,
 * arrondi au demi le plus éloigné de zéro, puis réparti sur les comptes de
 * taxe selon les lignes de répartition d'origine.
 */
const fs = require('fs');
const path = require('path');
const { LedgerError, diviserArrondi, lireTaux, verifierMontant } = require('./money');

const DOSSIER = path.join(__dirname, '..', 'data', 'taxes');
const PAYS = Object.freeze(['cd']);
const cache = new Map();

function lireFichier(pays) {
  if (!cache.has(pays)) cache.set(pays, JSON.parse(fs.readFileSync(path.join(DOSSIER, `${pays}.json`), 'utf8')));
  return cache.get(pays);
}

/** Taxes d'un pays pour un plan donné ('syscohada' ou 'syscebnl'). */
function loadTaxes(pays = 'cd', plan = 'syscohada') {
  const code = String(pays).toLowerCase();
  if (!PAYS.includes(code)) {
    throw new LedgerError('UNKNOWN_TAX_COUNTRY', `Aucune taxe livrée pour ${pays}. Pays livrés : ${PAYS.join(', ')}.`);
  }
  const fichier = lireFichier(code);
  const donnees = fichier.charts[plan];
  if (!donnees) throw new LedgerError('UNKNOWN_CHART', `Pas de taxes ${pays} pour le plan ${plan}.`);
  return { country: fichier.country, chart: plan, source: fichier.source, groups: donnees.groups, taxes: donnees.taxes };
}

/**
 * Calcule une taxe sur une base hors taxe (plus petite unité) et rend les
 * lignes d'écriture correspondantes (débit/crédit), prêtes à joindre à une
 * écriture. `document` vaut 'invoice' (facture) ou 'refund' (avoir).
 */
function computeTax(base, taxe, { document = 'invoice' } = {}) {
  verifierMontant(base, 'base');
  if (!taxe || !Array.isArray(taxe.repartition)) throw new LedgerError('INVALID_TAX', 'Taxe invalide : attendu un objet issu de loadTaxes().');
  if (taxe.amountType !== 'percent') {
    throw new LedgerError('INVALID_TAX', `Type de taxe non pris en charge : ${taxe.amountType}.`);
  }
  const taux = lireTaux(taxe.amount, { zeroAllowed: true });
  const montant = Number(diviserArrondi(BigInt(base) * taux.num, taux.den * 100n));
  const lignes = [];
  for (const repartition of taxe.repartition) {
    if (repartition.kind !== 'tax' || repartition.document !== document || !repartition.account) continue;
    const part = Number(diviserArrondi(BigInt(montant) * BigInt(Math.round(repartition.factorPercent * 100)), 10000n));
    if (part === 0) continue;
    // Vente : la taxe est due (crédit). Achat : elle est récupérable (débit).
    // Un facteur négatif ou un avoir inverse le sens.
    let auDebit = taxe.use === 'purchase';
    if (part < 0) auDebit = !auDebit;
    if (document === 'refund') auDebit = !auDebit;
    const absolu = Math.abs(part);
    lignes.push({
      account: repartition.account,
      debit: auDebit ? absolu : 0,
      credit: auDebit ? 0 : absolu,
      tax: { code: taxe.id, base }
    });
  }
  return { base, amount: montant, lines: lignes };
}

module.exports = { loadTaxes, computeTax, TAX_COUNTRIES: PAYS };
