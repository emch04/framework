/**
 * Plans comptables.
 *
 * Les plans SYSCOHADA et SYSCEBNL viennent d'Odoo (LGPL-3, voir NOTICE) et
 * sont lus tels quels depuis data/charts/. Ce fichier n'y ajoute que ce qui
 * nous est propre : la classe de chaque compte (premier chiffre du code) et
 * un « profil » par plan, c'est-à-dire les comptes par défaut que le moteur
 * utilise (clients, fournisseurs, résultat, report à nouveau, TVA, change).
 */
const fs = require('fs');
const path = require('path');
const { LedgerError } = require('./money');

const DOSSIER = path.join(__dirname, '..', 'data', 'charts');

/** Comptes par défaut propres à chaque plan livré. */
const PROFILS = Object.freeze({
  syscohada: Object.freeze({
    receivable: '4111',
    payable: '4011',
    cash: '5711',
    resultProfit: '131',
    resultLoss: '139',
    retainedProfit: '121',
    retainedLoss: '1291',
    exchangeGain: '776',
    exchangeLoss: '676',
    vatCollected: Object.freeze(['443']),
    vatDeductible: Object.freeze(['445']),
    layout: 'syscohada'
  }),
  syscebnl: Object.freeze({
    receivable: '412',
    payable: '401',
    cash: '571',
    resultProfit: '131',
    resultLoss: '139',
    retainedProfit: '121',
    retainedLoss: '129',
    exchangeGain: '776',
    exchangeLoss: '676',
    vatCollected: Object.freeze(['443']),
    vatDeductible: Object.freeze(['445']),
    layout: 'syscebnl'
  })
});

const cache = new Map();

function classeDe(code) {
  return Number(code[0]);
}

function verifierCompte(compte) {
  if (!compte || typeof compte.code !== 'string' || !/^[1-9][0-9A-Za-z]*$/.test(compte.code)) {
    throw new LedgerError('INVALID_ACCOUNT', `Code de compte invalide : ${compte && compte.code}. Il commence par la classe (1 à 9).`);
  }
  const nom = compte.name || (compte.labels && (compte.labels.fr || compte.labels.en));
  if (!nom) throw new LedgerError('INVALID_ACCOUNT', `Le compte ${compte.code} n'a pas d'intitulé.`);
  return Object.freeze({
    code: compte.code,
    name: nom,
    ...(compte.labels ? { labels: Object.freeze({ ...compte.labels }) } : {}),
    class: classeDe(compte.code),
    type: compte.type || null,
    reconcile: Boolean(compte.reconcile),
    ...(compte.custom ? { custom: true } : {})
  });
}

/**
 * Charge un plan livré : 'syscohada' (entreprises) ou 'syscebnl'
 * (associations, ONG, entités à but non lucratif).
 */
function loadChart(id) {
  if (!PROFILS[id]) {
    throw new LedgerError('UNKNOWN_CHART', `Plan inconnu : ${id}. Plans livrés : ${Object.keys(PROFILS).join(', ')}.`);
  }
  if (!cache.has(id)) {
    const brut = JSON.parse(fs.readFileSync(path.join(DOSSIER, `${id}.json`), 'utf8'));
    cache.set(id, Object.freeze({
      id,
      name: brut.name,
      source: brut.source,
      profile: PROFILS[id],
      groups: Object.freeze((brut.groups || []).map((groupe) => Object.freeze({ ...groupe }))),
      accounts: Object.freeze(brut.accounts.map(verifierCompte))
    }));
  }
  return cache.get(id);
}

/**
 * Plan personnalisé : tes propres comptes, et les comptes par défaut que le
 * moteur doit utiliser (au minimum ceux du résultat pour la clôture).
 */
function createChart({ id = 'custom', name = 'Plan personnalisé', accounts = [], profile = {} } = {}) {
  const comptes = accounts.map(verifierCompte);
  const codes = new Set();
  for (const compte of comptes) {
    if (codes.has(compte.code)) throw new LedgerError('DUPLICATE_ACCOUNT', `Compte en double dans le plan : ${compte.code}.`);
    codes.add(compte.code);
  }
  return Object.freeze({
    id,
    name,
    source: null,
    profile: Object.freeze({ ...PROFILS.syscohada, layout: 'syscohada', ...profile }),
    groups: Object.freeze([]),
    accounts: Object.freeze(comptes)
  });
}

function listCharts() {
  return Object.keys(PROFILS);
}

module.exports = { loadChart, createChart, listCharts, verifierCompte };
