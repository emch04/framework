const { newDb } = require('pg-mem');
const { createPostgresMigrationRunner } = require('@astratra/store-postgres');
const { createPostgresLedgerStore, ledgerPostgresMigrations, createMemoryLedgerStore } = require('../src');
const { humain, ia, montage, jeuExemple } = require('./helpers');

/** Base Postgres en mémoire (pg-mem). Le verrou consultatif y est simulé et journalisé. */
function creerPool(journal) {
  const db = newDb();
  db.public.registerFunction({ name: 'current_database', returns: 'text', implementation: () => 'astratra_test' });
  db.public.registerFunction({ name: 'hashtext', args: ['text'], returns: 'integer', implementation: (t) => t.length });
  db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: ['integer'], returns: 'text', implementation: (cle) => { journal.push(cle); return ''; } });
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

async function storePostgres(journal = []) {
  const pool = creerPool(journal);
  const resultat = await createPostgresMigrationRunner({ pool }).run(ledgerPostgresMigrations('compta'));
  expect(resultat.applied).toEqual(['compta-001-schema']);
  return { pool, store: createPostgresLedgerStore({ pool, tablePrefix: 'compta' }) };
}

describe('stockage Postgres', () => {
  test('même jeu d’exemple, mêmes états qu’en mémoire', async () => {
    const verrous = [];
    const { store } = await storePostgres(verrous);
    const enBase = await montage({ store });
    const enMemoire = await montage({ store: createMemoryLedgerStore() });
    await jeuExemple(enBase);
    await jeuExemple(enMemoire);
    const etats = async (l) => ({
      balance: await l.trialBalance({ fiscalYear: '2026' }),
      bilan: await l.balanceSheet({ fiscalYear: '2026' }),
      resultat: await l.incomeStatement({ fiscalYear: '2026' }),
      tva: await l.vatReport({ from: '2026-01-01', to: '2026-12-31' })
    });
    expect(await etats(enBase)).toEqual(await etats(enMemoire));
    expect((await enBase.balanceSheet({ fiscalYear: '2026' })).totals).toEqual({ assets: 1184000000, liabilities: 1184000000 });
    expect(verrous.length).toBeGreaterThan(10);
  });

  test('numérotation, immutabilité et unicité du numéro garanties en SQL', async () => {
    const { store, pool } = await storePostgres();
    const ledger = await montage({ store });
    const b = await ledger.propose({ journal: 'VT', date: '2026-05-01', lines: [
      { account: '4111', partner: 'C1', debit: 100 }, { account: '7011', credit: 100 }] }, { actor: ia });
    const e = await ledger.validate(b.id, { actor: humain });
    expect(e.number).toBe('VT-2026-000001');
    await store.transaction('societe-test', async (tx) => {
      expect(await tx.replaceDraft(e.id, { ...e, lines: [] })).toBe(false);
      expect(await tx.deleteDraft(e.id)).toBe(false);
      expect(await tx.markPosted(e.id, { number: 'VT-2026-000099' })).toBe(false);
    });
    const { rows } = await pool.query('SELECT status, posted_number FROM compta_entries WHERE id = $1', [e.id]);
    expect(rows).toEqual([{ status: 'posted', posted_number: 'VT-2026-000001' }]);
    await expect(pool.query(
      "INSERT INTO compta_entries (entity_id, id, journal, fiscal_year, status, entry_date, posted_number, data) VALUES ('societe-test', 'x', 'VT', '2026', 'posted', '2026-05-02', 'VT-2026-000001', '{}')"
    )).rejects.toThrow();
  });

  test('clôture, lettrage et rapprochement passent par le stockage SQL', async () => {
    const { store } = await storePostgres();
    const ledger = await montage({ store });
    const facture = await ledger.post({ journal: 'VT', date: '2026-05-10', lines: [
      { account: '4111', partner: 'C1', debit: 116000 }, { account: '7011', credit: 116000 }] }, { actor: humain });
    const paiement = await ledger.post({ journal: 'BQ', date: '2026-05-20', lines: [
      { account: '5211', debit: 116000 }, { account: '4111', partner: 'C1', credit: 116000 }] }, { actor: humain });
    const m = await ledger.reconcile([facture.lines[0].id, paiement.lines[1].id], { actor: humain });
    expect(m.status).toBe('full');
    expect(await ledger.listMatchings({ lineId: paiement.lines[1].id })).toHaveLength(1);
    await ledger.importStatement({ account: '5211', lines: [{ id: 'r1', date: '2026-05-21', amount: 116000 }] }, { actor: humain });
    expect((await ledger.autoMatchStatement('5211', { actor: humain })).matched).toBe(1);
    expect((await ledger.bankReconciliation('5211', { date: '2026-12-31' })).balanced).toBe(true);
    const cloture = await ledger.closeFiscalYear('2026', { actor: humain });
    expect(cloture.openingEntry.number).toBe('AN-2027-000001');
    expect((await ledger.listFiscalYears()).map((f) => f.status)).toEqual(['closed', 'open']);
  });

  test('pool obligatoire, préfixe de table contrôlé', () => {
    expect(() => createPostgresLedgerStore({})).toThrow(/pool/);
    expect(() => ledgerPostgresMigrations('compta; DROP TABLE x')).toThrow(/préfixe/);
  });
});
