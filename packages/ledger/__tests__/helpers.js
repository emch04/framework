const { createLedger, createRateTable } = require('../src');

const humain = { id: 'u-comptable', kind: 'human', name: 'Comptable' };
const ia = { id: 'oracle', kind: 'ai' };

/** Grand livre SYSCOHADA en CDF, exercices 2026 et 2027 ouverts, banque 5211. */
async function montage(options = {}) {
  const ledger = createLedger({
    entity: { id: 'societe-test', chart: 'syscohada', currency: 'CDF', ...(options.entity || {}) },
    rates: createRateTable({ rates: [
      { from: 'USD', to: 'CDF', date: '2026-01-01', rate: '2800' },
      { from: 'USD', to: 'CDF', date: '2026-06-01', rate: '2850.50' },
      { from: 'EUR', to: 'CDF', date: '2026-01-01', rate: '3100' }
    ] }),
    now: () => new Date('2026-10-01T10:00:00Z'),
    ...options
  });
  await ledger.openFiscalYear({ code: '2026', start: '2026-01-01', end: '2026-12-31' });
  await ledger.openFiscalYear({ code: '2027', start: '2027-01-01', end: '2027-12-31' });
  await ledger.addAccount({ code: '5211', name: 'Banque principale', type: 'asset_cash' });
  await ledger.addJournal({ code: 'BQ', type: 'bank', name: 'Banque principale', account: '5211' });
  await ledger.addPartner({ id: 'C1', name: 'Client Kinshasa', kind: 'customer' });
  await ledger.addPartner({ id: 'F1', name: 'Fournisseur Lubumbashi', kind: 'supplier' });
  return ledger;
}

/** Jeu d'écritures de l'exemple : capital, achat, vente, règlements, matériel, salaires, amortissement. */
async function jeuExemple(ledger) {
  const passer = (saisie) => ledger.post(saisie, { actor: humain });
  const e = {};
  e.capital = await passer({ journal: 'BQ', date: '2026-01-02', label: 'Apport en capital', lines: [
    { account: '5211', debit: 1000000000 }, { account: '1013', credit: 1000000000 }] });
  e.achat = await passer({ journal: 'AC', date: '2026-02-10', label: 'Facture F1-001', lines: [
    { account: '6011', debit: 200000000 },
    { account: '4452', debit: 32000000, tax: { code: 'tva_purchase_good_16', base: 200000000 } },
    { account: '4011', partner: 'F1', credit: 232000000 }] });
  e.vente = await passer({ journal: 'VT', date: '2026-03-05', label: 'Facture V-001', lines: [
    { account: '4111', partner: 'C1', debit: 464000000 },
    { account: '7011', credit: 400000000 },
    { account: '4431', credit: 64000000, tax: { code: 'tva_sale_16', base: 400000000 } }] });
  e.encaissement = await passer({ journal: 'BQ', date: '2026-03-20', label: 'Règlement C1', lines: [
    { account: '5211', debit: 300000000 }, { account: '4111', partner: 'C1', credit: 300000000 }] });
  e.reglement = await passer({ journal: 'BQ', date: '2026-03-25', label: 'Règlement F1', lines: [
    { account: '4011', partner: 'F1', debit: 232000000 }, { account: '5211', credit: 232000000 }] });
  e.materiel = await passer({ journal: 'BQ', date: '2026-04-01', label: 'Ordinateurs', lines: [
    { account: '2442', debit: 150000000 }, { account: '5211', credit: 150000000 }] });
  e.salaires = await passer({ journal: 'BQ', date: '2026-04-30', label: 'Salaires avril', lines: [
    { account: '6611', debit: 50000000 }, { account: '5211', credit: 50000000 }] });
  e.amortissement = await passer({ journal: 'OD', date: '2026-12-31', label: 'Dotation 2026', lines: [
    { account: '6813', debit: 30000000 }, { account: '2844', credit: 30000000 }] });
  return e;
}

module.exports = { humain, ia, montage, jeuExemple };
