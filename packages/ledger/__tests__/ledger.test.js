const { createLedger, createMemoryLedgerStore, LedgerError } = require('../src');
const { humain, ia, montage, jeuExemple } = require('./helpers');

const vente = (montant = 116000, extra = {}) => ({
  journal: 'VT',
  date: '2026-05-10',
  label: 'Facture',
  lines: [
    { account: '4111', partner: 'C1', debit: montant },
    { account: '7011', credit: montant }
  ],
  ...extra
});

async function erreur(promesse) {
  try {
    await promesse;
  } catch (e) {
    return e;
  }
  throw new Error('une erreur était attendue');
}

describe('équilibre', () => {
  test('une écriture équilibrée est validée avec débit = crédit', async () => {
    const ledger = await montage();
    const e = await ledger.post(vente(), { actor: humain });
    expect(e.status).toBe('posted');
    expect(e.totals).toEqual({ debit: 116000, credit: 116000 });
    expect(e.lines.map((l) => l.id)).toEqual([`${e.id}#1`, `${e.id}#2`]);
  });

  test('une écriture déséquilibrée est refusée, rien n’est enregistré', async () => {
    const ledger = await montage();
    const e = await erreur(ledger.post({ ...vente(), lines: [
      { account: '4111', partner: 'C1', debit: 116000 }, { account: '7011', credit: 115999 }] }, { actor: humain }));
    expect(e).toBeInstanceOf(LedgerError);
    expect(e.code).toBe('UNBALANCED_ENTRY');
    expect(e.details).toEqual({ debit: 116000, credit: 115999, difference: 1 });
    expect(await ledger.listEntries()).toEqual([]);
  });

  test('montants non entiers, négatifs, ligne double ou vide refusés', async () => {
    const ledger = await montage();
    const essai = (lignes) => erreur(ledger.post({ ...vente(), lines: lignes }, { actor: humain }));
    expect((await essai([{ account: '4111', debit: 10.5 }, { account: '7011', credit: 10.5 }])).code).toBe('INVALID_AMOUNT');
    expect((await essai([{ account: '4111', debit: -10 }, { account: '7011', credit: -10 }])).code).toBe('INVALID_AMOUNT');
    expect((await essai([{ account: '4111', debit: 10, credit: 10 }, { account: '7011', credit: 0 }])).code).toBe('INVALID_LINE');
    expect((await essai([{ account: '4111', debit: 10 }])).code).toBe('INVALID_ENTRY');
    expect((await essai([{ account: '9999999', debit: 10 }, { account: '7011', credit: 10 }])).code).toBe('UNKNOWN_ACCOUNT');
    expect((await essai([{ account: '4111', partner: 'X', debit: 10 }, { account: '7011', credit: 10 }])).code).toBe('UNKNOWN_PARTNER');
  });

  test('hors exercice ou journal inconnu refusé', async () => {
    const ledger = await montage();
    expect((await erreur(ledger.post(vente(116000, { date: '2025-12-31' }), { actor: humain }))).code).toBe('NO_FISCAL_YEAR');
    expect((await erreur(ledger.post(vente(116000, { journal: 'ZZ' }), { actor: humain }))).code).toBe('UNKNOWN_JOURNAL');
    expect((await erreur(ledger.post(vente(116000, { journal: 'AN' }), { actor: humain }))).code).toBe('RESERVED_JOURNAL');
  });
});

describe("l'IA propose, un humain valide", () => {
  test('brouillon proposé par l’IA, validé par un humain, hooks appelés', async () => {
    const evenements = [];
    const ledger = await montage({
      hooks: {
        onProposal: (e, a) => evenements.push(['proposal', e.status, a.kind]),
        beforeValidate: (e, a) => evenements.push(['before', e.status, a.kind]),
        afterValidate: (e) => evenements.push(['after', e.status, e.number])
      }
    });
    const brouillon = await ledger.propose({ ...vente(), rationale: 'Facture reçue par courriel' }, { actor: ia });
    expect(brouillon).toMatchObject({ status: 'draft', number: null, proposedBy: { kind: 'ai' }, rationale: 'Facture reçue par courriel' });
    const refus = await erreur(ledger.validate(brouillon.id, { actor: ia }));
    expect(refus.code).toBe('HUMAN_VALIDATION_REQUIRED');
    expect(await erreur(ledger.post(vente(), { actor: ia }))).toMatchObject({ code: 'HUMAN_VALIDATION_REQUIRED' });
    const validee = await ledger.validate(brouillon.id, { actor: humain });
    expect(validee).toMatchObject({ status: 'posted', number: 'VT-2026-000001', postedBy: { id: 'u-comptable' } });
    expect(evenements).toEqual([['proposal', 'draft', 'ai'], ['before', 'draft', 'human'], ['after', 'posted', 'VT-2026-000001']]);
  });

  test('un hook beforeValidate peut bloquer : rien n’est validé, aucun numéro consommé', async () => {
    let bloquer = true;
    const ledger = await montage({ hooks: { beforeValidate: () => { if (bloquer) throw new Error('Politique : pièce justificative manquante'); } } });
    const brouillon = await ledger.propose(vente(), { actor: ia });
    await expect(ledger.validate(brouillon.id, { actor: humain })).rejects.toThrow(/justificative/);
    expect((await ledger.getEntry(brouillon.id)).status).toBe('draft');
    bloquer = false;
    expect((await ledger.validate(brouillon.id, { actor: humain })).number).toBe('VT-2026-000001');
  });

  test('un brouillon se corrige ou se supprime ; il ne peut pas être déséquilibré', async () => {
    const ledger = await montage();
    const brouillon = await ledger.propose(vente(), { actor: ia });
    const corrige = await ledger.updateDraft(brouillon.id, vente(232000), { actor: humain });
    expect(corrige).toMatchObject({ id: brouillon.id, totals: { debit: 232000 }, proposedBy: { kind: 'ai' }, updatedBy: { kind: 'human' } });
    expect((await erreur(ledger.propose({ ...vente(), lines: [{ account: '4111', debit: 2 }, { account: '7011', credit: 1 }] }, { actor: ia }))).code).toBe('UNBALANCED_ENTRY');
    expect(await ledger.discardDraft(brouillon.id, { actor: humain })).toBe(true);
    expect(await ledger.getEntry(brouillon.id)).toBeNull();
  });

  test('acteur absent ou de nature inconnue refusé', async () => {
    const ledger = await montage();
    expect((await erreur(ledger.propose(vente(), {}))).code).toBe('INVALID_ACTOR');
    expect((await erreur(ledger.propose(vente(), { actor: { id: 'x', kind: 'robot' } }))).code).toBe('INVALID_ACTOR');
  });
});

describe('immutabilité', () => {
  test('une écriture validée ne se modifie pas, ne se supprime pas, ne se revalide pas', async () => {
    const ledger = await montage();
    const e = await ledger.post(vente(), { actor: humain });
    expect((await erreur(ledger.updateDraft(e.id, vente(1), { actor: humain }))).code).toBe('ENTRY_IMMUTABLE');
    expect((await erreur(ledger.discardDraft(e.id, { actor: humain }))).code).toBe('ENTRY_IMMUTABLE');
    expect((await erreur(ledger.validate(e.id, { actor: humain }))).code).toBe('ENTRY_IMMUTABLE');
  });

  test('modifier l’objet rendu ne touche pas la donnée stockée', async () => {
    const ledger = await montage();
    const e = await ledger.post(vente(), { actor: humain });
    e.lines[0].debit = 1;
    const relue = await ledger.getEntry(e.id);
    relue.lines[1].credit = 1;
    expect((await ledger.getEntry(e.id)).lines.map((l) => [l.debit, l.credit])).toEqual([[116000, 0], [0, 116000]]);
  });

  test('transaction tout ou rien : une erreur en cours de route ne laisse aucune trace', async () => {
    const store = createMemoryLedgerStore();
    const ledger = await montage({ store });
    const e = await ledger.post(vente(), { actor: humain });
    await expect(store.transaction('societe-test', async (tx) => {
      await tx.insertEntry({ ...e, id: 'fantome', status: 'draft' });
      await tx.setSequence('VT', '2026', { last: 99, lastDate: '2026-12-31' });
      throw new Error('panne');
    })).rejects.toThrow('panne');
    expect(await ledger.getEntry('fantome')).toBeNull();
    expect((await ledger.post(vente(), { actor: humain })).number).toBe('VT-2026-000002');
  });

  test('le stockage lui-même refuse de remplacer, supprimer ou revalider une écriture validée', async () => {
    const store = createMemoryLedgerStore();
    const ledger = await montage({ store });
    const e = await ledger.post(vente(), { actor: humain });
    await store.transaction('societe-test', async (tx) => {
      expect(await tx.replaceDraft(e.id, { ...e, lines: [] })).toBe(false);
      expect(await tx.deleteDraft(e.id)).toBe(false);
      expect(await tx.markPosted(e.id, { number: 'X' })).toBe(false);
    });
    expect((await ledger.getEntry(e.id)).number).toBe('VT-2026-000001');
  });
});

describe('contre-passation', () => {
  test('écriture miroir validée, liée à l’originale qui reste intacte ; soldes ramenés à zéro', async () => {
    const ledger = await montage();
    const e = await ledger.post(vente(), { actor: humain });
    const avant = await ledger.getEntry(e.id);
    const inverse = await ledger.reverse(e.id, { actor: humain });
    expect(inverse).toMatchObject({ status: 'posted', reverses: e.id, number: 'VT-2026-000002', label: 'Contre-passation de VT-2026-000001' });
    expect(inverse.lines.map((l) => [l.account, l.debit, l.credit, l.partner])).toEqual([['4111', 0, 116000, 'C1'], ['7011', 116000, 0, undefined]]);
    expect(await ledger.getEntry(e.id)).toEqual(avant);
    const balance = await ledger.trialBalance({ fiscalYear: '2026' });
    expect(balance.rows.every((r) => r.closingDebit === 0 && r.closingCredit === 0)).toBe(true);
  });

  test('ni double contre-passation, ni contre-passation d’une contre-passation, ni d’un brouillon ; humain requis', async () => {
    const ledger = await montage();
    const e = await ledger.post(vente(), { actor: humain });
    const inverse = await ledger.reverse(e.id, { actor: humain });
    expect((await erreur(ledger.reverse(e.id, { actor: humain }))).code).toBe('ALREADY_REVERSED');
    expect((await erreur(ledger.reverse(inverse.id, { actor: humain }))).code).toBe('ALREADY_REVERSED');
    const brouillon = await ledger.propose(vente(), { actor: ia });
    expect((await erreur(ledger.reverse(brouillon.id, { actor: humain }))).code).toBe('ENTRY_NOT_POSTED');
    const autre = await ledger.post(vente(), { actor: humain });
    expect((await erreur(ledger.reverse(autre.id, { actor: ia }))).code).toBe('HUMAN_VALIDATION_REQUIRED');
  });

  test('par défaut, datée au plus tôt à la dernière date du journal pour garder l’ordre chronologique', async () => {
    const ledger = await montage();
    const e = await ledger.post(vente(116000, { date: '2026-02-01' }), { actor: humain });
    await ledger.post(vente(116000, { date: '2026-04-01' }), { actor: humain });
    expect((await ledger.reverse(e.id, { actor: humain })).date).toBe('2026-04-01');
  });
});

describe('numérotation', () => {
  test('séquentielle par journal et par exercice, sans trou malgré les brouillons supprimés', async () => {
    const ledger = await montage();
    const b1 = await ledger.propose(vente(), { actor: ia });
    const b2 = await ledger.propose(vente(), { actor: ia });
    const b3 = await ledger.propose(vente(), { actor: ia });
    await ledger.discardDraft(b2.id, { actor: humain });
    expect((await ledger.validate(b3.id, { actor: humain })).number).toBe('VT-2026-000001');
    expect((await ledger.validate(b1.id, { actor: humain })).number).toBe('VT-2026-000002');
    expect((await ledger.post({ ...vente(), journal: 'OD' }, { actor: humain })).number).toBe('OD-2026-000001');
    expect((await ledger.post(vente(116000, { date: '2027-01-05' }), { actor: humain })).number).toBe('VT-2027-000001');
  });

  test('une validation refusée ne consomme pas de numéro', async () => {
    const ledger = await montage();
    await ledger.post(vente(116000, { date: '2026-06-01' }), { actor: humain });
    const ancienne = await ledger.propose(vente(116000, { date: '2026-05-01' }), { actor: ia });
    expect((await erreur(ledger.validate(ancienne.id, { actor: humain }))).code).toBe('CHRONOLOGY');
    expect((await ledger.post(vente(116000, { date: '2026-06-02' }), { actor: humain })).number).toBe('VT-2026-000002');
  });

  test('validations simultanées : chaque numéro une seule fois, suite continue', async () => {
    const ledger = await montage();
    const brouillons = [];
    for (let i = 0; i < 20; i += 1) brouillons.push(await ledger.propose(vente(1000 + i), { actor: ia }));
    const validees = await Promise.all(brouillons.map((b) => ledger.validate(b.id, { actor: humain })));
    const rangs = validees.map((v) => v.sequence).sort((a, b) => a - b);
    expect(rangs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe('multi-devises', () => {
  test('écriture en USD convertie en CDF au taux de la date, montant en devise conservé', async () => {
    const ledger = await montage();
    const e = await ledger.post({ ...vente(), date: '2026-06-15', currency: 'USD', lines: [
      { account: '4111', partner: 'C1', debit: 10000 }, { account: '7011', credit: 10000 }] }, { actor: humain });
    expect(e.rate).toMatchObject({ date: '2026-06-01', source: 'table' });
    expect(e.lines[0]).toMatchObject({ currency: 'USD', amountCurrency: 10000, debit: 28505000 });
    expect(e.lines[1]).toMatchObject({ currency: 'USD', amountCurrency: -10000, credit: 28505000 });
  });

  test('taux manuel ; arrondis de conversion rééquilibrés en devise de tenue', async () => {
    const ledger = await montage();
    const e = await ledger.post({ ...vente(), currency: 'USD', rate: '2850.555', lines: [
      { account: '4111', partner: 'C1', debit: 1 }, { account: '4111', partner: 'C1', debit: 1 }, { account: '7011', credit: 2 }] }, { actor: humain });
    expect(e.totals.debit).toBe(e.totals.credit);
    expect(e.lines.map((l) => [l.debit, l.credit])).toEqual([[2851, 0], [2851, 0], [0, 5702]]);
    const e2 = await ledger.post({ ...vente(), currency: 'USD', rate: '0.333', lines: [
      { account: '4111', partner: 'C1', debit: 1 }, { account: '4111', partner: 'C1', debit: 1 }, { account: '7011', credit: 2 }] }, { actor: humain });
    expect(e2.totals.debit).toBe(e2.totals.credit);
    expect(e2.conversionRounding).toBe(-1);
  });

  test('devise de tenue XAF (0 décimale) depuis EUR', async () => {
    const { createRateTable } = require('../src');
    const ledger = createLedger({
      entity: { id: 'cm', chart: 'syscohada', currency: 'XAF' },
      rates: createRateTable({ rates: [{ from: 'EUR', to: 'XAF', date: '2026-01-01', rate: '655.957' }] })
    });
    await ledger.openFiscalYear({ code: '2026', start: '2026-01-01', end: '2026-12-31' });
    const e = await ledger.post({ journal: 'OD', date: '2026-03-01', currency: 'EUR', lines: [
      { account: '6011', debit: 10000 }, { account: '4011', credit: 10000 }] }, { actor: humain });
    expect(e.lines[0].debit).toBe(65596);
  });

  test('sans taux à la date : refus explicite', async () => {
    const ledger = await montage();
    expect((await erreur(ledger.post({ ...vente(), currency: 'XOF' }, { actor: humain }))).code).toBe('RATE_NOT_FOUND');
  });
});

describe('états sur le jeu d’exemple', () => {
  test('balance : débit = crédit, totaux par classe', async () => {
    const ledger = await montage();
    await jeuExemple(ledger);
    const balance = await ledger.trialBalance({ fiscalYear: '2026' });
    expect(balance.balanced).toBe(true);
    expect(balance.totals.debit).toBe(balance.totals.credit);
    expect(balance.totals.debit).toBe(1000000000 + 232000000 + 464000000 + 300000000 + 232000000 + 150000000 + 50000000 + 30000000);
    const banque = balance.rows.find((r) => r.account === '5211');
    expect(banque).toMatchObject({ debit: 1300000000, credit: 432000000, closingDebit: 868000000, closingCredit: 0 });
    expect(balance.classes.find((c) => c.class === 7)).toMatchObject({ credit: 400000000, closingCredit: 400000000 });
  });

  test('bilan SYSCOHADA : rubriques, brut / amortissements / net, actif = passif', async () => {
    const ledger = await montage();
    await jeuExemple(ledger);
    const bilan = await ledger.balanceSheet({ fiscalYear: '2026' });
    const actif = Object.fromEntries(bilan.assets.map((l) => [l.code, l]));
    const passif = Object.fromEntries(bilan.liabilities.map((l) => [l.code, l]));
    expect(actif.AI).toMatchObject({ gross: 150000000, depreciation: 30000000, net: 120000000 });
    expect(actif.AZ.net).toBe(120000000);
    expect(actif.BI.net).toBe(164000000);
    expect(actif.BJ.net).toBe(32000000);
    expect(actif.BS.net).toBe(868000000);
    expect(actif.BK.net).toBe(196000000);
    expect(passif.CA.amount).toBe(1000000000);
    expect(passif.CJ.amount).toBe(120000000);
    expect(passif.DK.amount).toBe(64000000);
    expect(passif.DJ.amount).toBe(0);
    expect(bilan.totals).toEqual({ assets: 1184000000, liabilities: 1184000000 });
    expect(bilan.balanced).toBe(true);
    expect(bilan.unclassified).toEqual({ assets: [], liabilities: [] });
  });

  test('compte de résultat SYSCOHADA : soldes intermédiaires jusqu’au résultat net', async () => {
    const ledger = await montage();
    await jeuExemple(ledger);
    const cr = await ledger.incomeStatement({ fiscalYear: '2026' });
    const v = Object.fromEntries(cr.lines.map((l) => [l.code, l.amount]));
    expect(v).toMatchObject({ TA: 400000000, RA: 200000000, XA: 200000000, XB: 400000000, XC: 200000000, RK: 50000000, XD: 150000000, RL: 30000000, XE: 120000000, XG: 120000000, XI: 120000000 });
    expect(cr.result).toBe(120000000);
    expect(cr.totals).toEqual({ income: 400000000, expenses: 280000000 });
  });

  test('TVA collectée / déductible et détail par taxe', async () => {
    const ledger = await montage();
    await jeuExemple(ledger);
    const tva = await ledger.vatReport({ from: '2026-01-01', to: '2026-12-31' });
    expect(tva).toMatchObject({ collected: 64000000, deductible: 32000000, due: 32000000 });
    expect(tva.taxes).toEqual([
      { code: 'tva_purchase_good_16', base: 200000000, amount: 32000000 },
      { code: 'tva_sale_16', base: 400000000, amount: 64000000 }
    ]);
    const mars = await ledger.vatReport({ from: '2026-03-01', to: '2026-03-31' });
    expect(mars).toMatchObject({ collected: 64000000, deductible: 0, due: 64000000 });
  });

  test('grand livre : solde progressif ; grand livre auxiliaire par tiers ; journal', async () => {
    const ledger = await montage();
    await jeuExemple(ledger);
    const gl = await ledger.generalLedger({ fiscalYear: '2026', accounts: ['5211'] });
    expect(gl.accounts).toHaveLength(1);
    expect(gl.accounts[0].lines.map((l) => l.balance)).toEqual([1000000000, 1300000000, 1068000000, 918000000, 868000000]);
    expect(gl.accounts[0].closing).toBe(868000000);
    const aux = await ledger.generalLedger({ fiscalYear: '2026', accounts: ['4'], byPartner: true, partner: 'C1' });
    expect(aux.accounts).toEqual([expect.objectContaining({ account: '4111', partner: 'C1', closing: 164000000 })]);
    const journal = await ledger.journalReport('BQ', { fiscalYear: '2026' });
    expect(journal.entries.map((e) => e.number)).toEqual(['BQ-2026-000001', 'BQ-2026-000002', 'BQ-2026-000003', 'BQ-2026-000004', 'BQ-2026-000005']);
    expect(journal.totals.debit).toBe(journal.totals.credit);
  });

  test('balance sur une période : à-nouveaux de période et mouvements', async () => {
    const ledger = await montage();
    await jeuExemple(ledger);
    const t2 = await ledger.trialBalance({ fiscalYear: '2026', from: '2026-04-01', to: '2026-06-30' });
    const banque = t2.rows.find((r) => r.account === '5211');
    expect(banque).toMatchObject({ openingDebit: 1068000000, debit: 0, credit: 200000000, closingDebit: 868000000 });
    expect(t2.balanced).toBe(true);
  });
});

describe('clôture et report à nouveau', () => {
  test('solde les classes 6-8 dans 131, verrouille 2026, reporte les classes 1-5 en 2027', async () => {
    const fins = [];
    const ledger = await montage({ hooks: { afterClose: (b) => fins.push(b.fiscalYear) } });
    await jeuExemple(ledger);
    const bilanAvant = await ledger.balanceSheet({ fiscalYear: '2026' });
    const cloture = await ledger.closeFiscalYear('2026', { actor: humain });
    expect(cloture.result).toBe(120000000);
    expect(cloture.closingEntry).toMatchObject({ journal: 'OD', date: '2026-12-31', number: 'OD-2026-000002', meta: { kind: 'closing' } });
    expect(cloture.closingEntry.lines.find((l) => l.account === '131')).toMatchObject({ credit: 120000000 });
    expect(cloture.openingEntry).toMatchObject({ journal: 'AN', date: '2027-01-01', number: 'AN-2027-000001' });
    expect(fins).toEqual(['2026']);

    // L'exercice clôturé n'accepte plus rien.
    expect((await erreur(ledger.post(vente(1, { date: '2026-12-30' }), { actor: humain }))).code).toBe('FISCAL_YEAR_CLOSED');
    expect((await erreur(ledger.reverse(cloture.closingEntry.id, { actor: humain }))).code).toBe('RESERVED_JOURNAL');
    expect((await erreur(ledger.closeFiscalYear('2026', { actor: humain }))).code).toBe('FISCAL_YEAR_CLOSED');
    expect((await ledger.listFiscalYears())[0]).toMatchObject({ status: 'closed', result: 120000000 });

    // Le bilan 2026 ne change pas avec la clôture ; le compte de résultat reste lisible.
    expect(await ledger.balanceSheet({ fiscalYear: '2026' })).toEqual(bilanAvant);
    expect((await ledger.incomeStatement({ fiscalYear: '2026' })).result).toBe(120000000);
    const balance2026 = await ledger.trialBalance({ fiscalYear: '2026', includeClosing: true });
    expect(balance2026.rows.filter((r) => r.class >= 6 && r.class <= 8).every((r) => r.closingDebit === 0 && r.closingCredit === 0)).toBe(true);

    // 2027 s'ouvre avec le même bilan : à-nouveaux équilibrés, classes 1 à 5 seulement.
    const ouverture = await ledger.trialBalance({ fiscalYear: '2027' });
    expect(ouverture.balanced).toBe(true);
    expect(ouverture.rows.every((r) => r.class <= 5)).toBe(true);
    expect(ouverture.rows.find((r) => r.account === '131')).toMatchObject({ openingCredit: 120000000 });
    expect(ouverture.rows.find((r) => r.account === '5211')).toMatchObject({ openingDebit: 868000000 });
    const bilan2027 = await ledger.balanceSheet({ fiscalYear: '2027' });
    expect(bilan2027.totals).toEqual(bilanAvant.totals);
    expect((await ledger.incomeStatement({ fiscalYear: '2027' })).result).toBe(0);
  });

  test('affectation en report à nouveau : bénéfice en 121, perte en 1291', async () => {
    const benefice = await montage();
    await jeuExemple(benefice);
    const c1 = await benefice.closeFiscalYear('2026', { actor: humain, allocateResult: true });
    expect(c1.openingEntry.lines.find((l) => l.account === '121')).toMatchObject({ credit: 120000000 });
    expect(c1.openingEntry.lines.find((l) => l.account === '131')).toBeUndefined();

    const perte = await montage();
    await perte.post({ journal: 'OD', date: '2026-06-01', lines: [{ account: '6611', debit: 5000 }, { account: '5211', credit: 5000 }] }, { actor: humain });
    const c2 = await perte.closeFiscalYear('2026', { actor: humain, allocateResult: true });
    expect(c2.result).toBe(-5000);
    expect(c2.closingEntry.lines.find((l) => l.account === '139')).toMatchObject({ debit: 5000 });
    expect(c2.openingEntry.lines.find((l) => l.account === '1291')).toMatchObject({ debit: 5000 });
  });

  test('les engagements hors bilan (classe 9) ne sont ni dans le bilan ni reportés', async () => {
    const ledger = await montage();
    await jeuExemple(ledger);
    await ledger.post({ journal: 'OD', date: '2026-12-31', label: 'Caution obtenue', lines: [
      { account: '9022', debit: 7000000 }, { account: '9021', credit: 7000000 }] }, { actor: humain });
    expect((await ledger.balanceSheet({ fiscalYear: '2026' })).totals.assets).toBe(1184000000);
    const { openingEntry } = await ledger.closeFiscalYear('2026', { actor: humain });
    expect(openingEntry.lines.some((l) => l.account.startsWith('9'))).toBe(false);
    expect(openingEntry.lines.every((l) => Number(l.account[0]) <= 5)).toBe(true);
  });

  test('refus : brouillons en attente, exercice suivant absent, acteur non humain', async () => {
    const ledger = await montage();
    const brouillon = await ledger.propose(vente(), { actor: ia });
    const e = await erreur(ledger.closeFiscalYear('2026', { actor: humain }));
    expect(e.code).toBe('DRAFTS_PENDING');
    expect(e.details.drafts).toEqual([brouillon.id]);
    await ledger.discardDraft(brouillon.id, { actor: humain });
    expect((await erreur(ledger.closeFiscalYear('2026', { actor: ia }))).code).toBe('HUMAN_VALIDATION_REQUIRED');
    expect((await erreur(ledger.closeFiscalYear('2027', { actor: humain }))).code).toBe('NEXT_FISCAL_YEAR_REQUIRED');
    expect((await ledger.closeFiscalYear('2027', { actor: humain, carryForward: false })).openingEntry).toBeNull();
  });

  test('exercices : chevauchement et dates invalides refusés', async () => {
    const ledger = await montage();
    expect((await erreur(ledger.openFiscalYear({ code: '2026b', start: '2026-07-01', end: '2027-06-30' }))).code).toBe('OVERLAPPING_FISCAL_YEAR');
    expect((await erreur(ledger.openFiscalYear({ code: '2028', start: '2028-02-30', end: '2028-12-31' }))).code).toBe('INVALID_DATE');
  });
});

describe('lettrage', () => {
  test('facture + règlement partiel → lettrage partiel ; solde → total ; pièces ouvertes', async () => {
    const ledger = await montage();
    const facture = await ledger.post(vente(116000), { actor: humain });
    const acompte = await ledger.post({ journal: 'BQ', date: '2026-05-15', lines: [
      { account: '5211', debit: 50000 }, { account: '4111', partner: 'C1', credit: 50000 }] }, { actor: humain });
    const partiel = await ledger.reconcile([facture.lines[0].id, acompte.lines[1].id], { actor: humain });
    expect(partiel).toMatchObject({ status: 'partial', residual: 66000, letters: 'A', account: '4111', partner: 'C1' });
    expect((await ledger.openItems({ account: '4111', partner: 'C1' })).map((i) => i.partialMatching)).toEqual(['A', 'A']);

    const solde = await ledger.post({ journal: 'BQ', date: '2026-05-20', lines: [
      { account: '5211', debit: 66000 }, { account: '4111', partner: 'C1', credit: 66000 }] }, { actor: humain });
    const total = await ledger.reconcile([solde.lines[1].id, facture.lines[0].id], { actor: ia });
    expect(total).toMatchObject({ status: 'full', residual: 0, letters: 'A' });
    expect(total.lineIds).toHaveLength(3);
    expect(await ledger.listMatchings({ account: '4111' })).toHaveLength(1);
    expect(await ledger.openItems({ account: '4111' })).toEqual([]);
    expect((await erreur(ledger.reconcile([facture.lines[0].id, solde.lines[1].id], { actor: humain }))).code).toBe('ALREADY_MATCHED');
  });

  test('une écriture lettrée ne se contre-passe qu’après délettrage', async () => {
    const ledger = await montage();
    const facture = await ledger.post(vente(), { actor: humain });
    const paiement = await ledger.post({ journal: 'BQ', date: '2026-05-20', lines: [
      { account: '5211', debit: 116000 }, { account: '4111', partner: 'C1', credit: 116000 }] }, { actor: humain });
    const m = await ledger.reconcile([facture.lines[0].id, paiement.lines[1].id], { actor: humain });
    expect((await erreur(ledger.reverse(facture.id, { actor: humain }))).code).toBe('LINE_MATCHED');
    await ledger.unreconcile(m.code, { actor: humain });
    expect((await ledger.reverse(facture.id, { actor: humain })).reverses).toBe(facture.id);
  });

  test('refus : compte non lettrable, comptes ou tiers différents ; délettrage', async () => {
    const ledger = await montage();
    const a = await ledger.post(vente(), { actor: humain });
    const b = await ledger.post(vente(), { actor: humain });
    expect((await erreur(ledger.reconcile([a.lines[1].id, b.lines[1].id], { actor: humain }))).code).toBe('ACCOUNT_NOT_RECONCILABLE');
    expect((await erreur(ledger.reconcile([a.lines[0].id, b.lines[1].id], { actor: humain }))).code).toBe('INVALID_MATCHING');
    await ledger.addPartner({ id: 'C2', name: 'Autre client', kind: 'customer' });
    const c = await ledger.post({ ...vente(), lines: [{ account: '4111', partner: 'C2', debit: 5 }, { account: '7011', credit: 5 }] }, { actor: humain });
    expect((await erreur(ledger.reconcile([a.lines[0].id, c.lines[0].id], { actor: humain }))).message).toMatch(/même tiers/);
    const m = await ledger.reconcile([a.lines[0].id, b.lines[0].id], { actor: humain });
    expect(m.status).toBe('partial');
    expect(await ledger.unreconcile(m.code, { actor: humain })).toBe(true);
    expect(await ledger.listMatchings()).toEqual([]);
  });

  test('en devise : l’écart de change est passé en 676 / 776 et le lettrage est total', async () => {
    const ledger = await montage();
    const facture = await ledger.post({ journal: 'VT', date: '2026-05-10', currency: 'USD', lines: [
      { account: '4111', partner: 'C1', debit: 10000 }, { account: '7011', credit: 10000 }] }, { actor: humain });
    const paiement = await ledger.post({ journal: 'BQ', date: '2026-06-10', currency: 'USD', lines: [
      { account: '5211', debit: 10000 }, { account: '4111', partner: 'C1', credit: 10000 }] }, { actor: humain });
    expect((await erreur(ledger.reconcile([facture.lines[0].id, paiement.lines[1].id], { actor: ia }))).code).toBe('HUMAN_VALIDATION_REQUIRED');
    const m = await ledger.reconcile([facture.lines[0].id, paiement.lines[1].id], { actor: humain });
    expect(m.status).toBe('full');
    const ecart = await ledger.getEntry(m.exchangeEntryId);
    // 100 USD facturés à 2800, payés à 2850,50 : gain de 5 050 CDF.
    expect(ecart.lines.find((l) => l.account === '776')).toMatchObject({ credit: 505000 });
    expect(ecart.lines.find((l) => l.account === '4111')).toMatchObject({ debit: 505000, amountCurrency: 0, currency: 'USD' });
    const gl = await ledger.generalLedger({ fiscalYear: '2026', accounts: ['4111'] });
    expect(gl.accounts[0].closing).toBe(0);
  });

  test('après clôture, les pièces ouvertes sont reportées une à une et se lettrent sur la ligne reportée', async () => {
    const ledger = await montage();
    const facture = await ledger.post(vente(116000, { label: 'Facture 99' }), { actor: humain });
    await ledger.post({ journal: 'VT', date: '2026-06-01', lines: [{ account: '4111', partner: 'C1', debit: 1000 }, { account: '7011', credit: 1000 }] }, { actor: humain });
    const { openingEntry } = await ledger.closeFiscalYear('2026', { actor: humain });
    const reportees = openingEntry.lines.filter((l) => l.account === '4111');
    expect(reportees).toHaveLength(2);
    expect(reportees[0]).toMatchObject({ partner: 'C1', debit: 116000, carriedFrom: [facture.lines[0].id] });
    const items = await ledger.openItems({ account: '4111' });
    expect(items.map((i) => i.lineId).sort()).toEqual(reportees.map((l) => l.id).sort());
    const paiement = await ledger.post({ journal: 'BQ', date: '2027-02-01', lines: [
      { account: '5211', debit: 116000 }, { account: '4111', partner: 'C1', credit: 116000 }] }, { actor: humain });
    expect((await erreur(ledger.reconcile([facture.lines[0].id, paiement.lines[1].id], { actor: humain }))).code).toBe('LINE_CARRIED_FORWARD');
    expect((await ledger.reconcile([reportees[0].id, paiement.lines[1].id], { actor: humain })).status).toBe('full');
  });
});

describe('comptes, tiers et journaux', () => {
  test('ajout de compte, doublon refusé ; tiers rattaché au collectif par défaut', async () => {
    const ledger = await montage();
    expect((await ledger.getAccount('5211'))).toMatchObject({ name: 'Banque principale', class: 5, custom: true });
    expect((await erreur(ledger.addAccount({ code: '4111', name: 'Doublon' }))).code).toBe('DUPLICATE_ACCOUNT');
    expect(await ledger.getPartner('C1')).toEqual({ id: 'C1', name: 'Client Kinshasa', kind: 'customer', account: '4111' });
    expect((await ledger.listAccounts({ class: 5 })).some((c) => c.code === '5211')).toBe(true);
    expect((await ledger.listJournals()).map((j) => j.code)).toEqual(['AC', 'VT', 'CA', 'OD', 'AN', 'BQ']);
  });

  test('journal de banque sans compte ou sur un compte hors classe 5 refusé', async () => {
    const ledger = await montage();
    expect((await erreur(ledger.addJournal({ code: 'BQ2', type: 'bank' }))).code).toBe('INVALID_JOURNAL');
    expect((await erreur(ledger.addJournal({ code: 'BQ2', type: 'bank', account: '4111' }))).code).toBe('INVALID_JOURNAL');
    expect((await erreur(ledger.addJournal({ code: 'BQ', type: 'bank', account: '5211' }))).code).toBe('DUPLICATE_JOURNAL');
  });

  test('SYSCEBNL : association, bilan et compte de résultat par groupes', async () => {
    const ledger = createLedger({ entity: { id: 'ong', chart: 'syscebnl', currency: 'USD' } });
    await ledger.openFiscalYear({ code: '2026', start: '2026-01-01', end: '2026-12-31' });
    await ledger.post({ journal: 'OD', date: '2026-01-10', label: 'Dotation initiale', lines: [{ account: '521', debit: 500000 }, { account: '104', credit: 500000 }] }, { actor: humain });
    await ledger.post({ journal: 'OD', date: '2026-02-10', label: 'Cotisations', lines: [{ account: '521', debit: 80000 }, { account: '7051', credit: 80000 }] }, { actor: humain });
    await ledger.post({ journal: 'OD', date: '2026-03-10', label: 'Achats', lines: [{ account: '601', debit: 30000 }, { account: '521', credit: 30000 }] }, { actor: humain });
    const bilan = await ledger.balanceSheet({ fiscalYear: '2026' });
    expect(bilan.balanced).toBe(true);
    expect(bilan.totals.assets).toBe(550000);
    const passif = Object.fromEntries(bilan.liabilities.map((l) => [l.code, l]));
    expect(passif.C10).toMatchObject({ label: 'Dotation', amount: 500000 });
    expect(passif.C13.amount).toBe(50000);
    const cr = await ledger.incomeStatement({ fiscalYear: '2026' });
    expect(cr.layout).toBe('syscebnl');
    expect(cr.result).toBe(50000);
    expect(cr.lines.find((l) => l.code === 'G60')).toMatchObject({ label: 'Achats et variations de stocks', amount: 30000 });
  });
});
