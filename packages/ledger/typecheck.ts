import {
  createLedger, createMemoryLedgerStore, createPostgresLedgerStore, ledgerPostgresMigrations, createRateTable,
  createCurrencies, loadChart, createChart, listCharts, loadTaxes, computeTax, LedgerError, CURRENCY_DECIMALS,
  JOURNAL_TYPES, ACTOR_KINDS, TAX_COUNTRIES
} from './src';
import type {
  Actor, BalanceSheet, BankReconciliation, Chart, ClosingResult, Entry, IncomeStatement, Ledger, LedgerStore,
  Matching, OpenItem, PgPoolLike, TaxComputation, TrialBalance, VatReport
} from './src';

const humain: Actor = { id: 'u1', kind: 'human' };
const plan: Chart = loadChart('syscohada');
const perso: Chart = createChart({ accounts: [{ code: '701', name: 'Ventes' }], profile: { resultProfit: '120' } });
const store: LedgerStore = createMemoryLedgerStore();
const taux = createRateTable({ rates: [{ from: 'USD', to: 'CDF', date: '2026-01-01', rate: '2850.50' }] }).add({ from: 'EUR', to: 'CDF', date: '2026-01-01', rate: 3100 });
const ledger: Ledger = createLedger({
  entity: { id: 'e1', chart: 'syscebnl', currency: 'USD' },
  store,
  rates: taux,
  currencies: { GBP: 2 },
  hooks: { onProposal: (e: Entry) => { void e.status; }, beforeValidate: async () => {} },
  now: () => new Date()
});
const tva: TaxComputation = computeTax(100000, loadTaxes('cd', 'syscohada').taxes[0], { document: 'refund' });
const decimales: number = createCurrencies().decimals('XAF') + CURRENCY_DECIMALS.CDF;
const listes: string[] = [...listCharts(), ...JOURNAL_TYPES, ...ACTOR_KINDS, ...TAX_COUNTRIES];

declare const pool: PgPoolLike;
const enBase: LedgerStore = createPostgresLedgerStore({ pool, tablePrefix: 'compta' });
const migrations = ledgerPostgresMigrations('compta').map((m) => m.id);

async function parcours(): Promise<void> {
  await ledger.openFiscalYear({ code: '2026', start: '2026-01-01', end: '2026-12-31' });
  const brouillon: Entry = await ledger.propose({
    journal: 'VT', date: '2026-02-01', currency: 'EUR', rationale: 'facture',
    lines: [{ account: '412', partner: null, debit: 100 }, { account: '7051', credit: 100, tax: { code: 'tva_sale_16', base: 100 } }]
  }, { actor: { id: 'ia', kind: 'ai' } });
  const validee: Entry = await ledger.validate(brouillon.id, { actor: humain });
  const inverse: Entry = await ledger.reverse(validee.id, { actor: humain, date: '2026-02-02' });
  const lettrage: Matching = await ledger.reconcile([validee.lines[0].id, inverse.lines[0].id], { actor: humain });
  const ouverts: OpenItem[] = await ledger.openItems({ account: '412', partner: null });
  await ledger.importStatement({ account: '521', lines: [{ date: '2026-02-03', amount: -10 }] }, { actor: humain });
  const rapprochement: BankReconciliation = await ledger.bankReconciliation('521', { date: '2026-12-31', statementBalance: 0 });
  const balance: TrialBalance = await ledger.trialBalance({ fiscalYear: '2026', includeClosing: true });
  const bilan: BalanceSheet = await ledger.balanceSheet({ fiscalYear: '2026' });
  const resultat: IncomeStatement = await ledger.incomeStatement({ from: '2026-01-01', to: '2026-06-30' });
  const declaration: VatReport = await ledger.vatReport({ from: '2026-01-01', to: '2026-03-31' });
  const cloture: ClosingResult = await ledger.closeFiscalYear('2026', { actor: humain, allocateResult: true, carryForward: false });
  void [lettrage.letters, ouverts.length, rapprochement.balanced, balance.balanced, bilan.totals.assets, resultat.result, declaration.due, cloture.result];
}

function attraper(e: unknown): string | null {
  return e instanceof LedgerError ? e.code : null;
}

export { plan, perso, tva, decimales, listes, enBase, migrations, parcours, attraper };
