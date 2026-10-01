export type Awaitable<T> = T | Promise<T>;

/** Montant entier en plus petite unité de la devise (centimes ; unité pour XAF/XOF). */
export type Minor = number;
/** Jour civil AAAA-MM-JJ. */
export type DateString = string;

export type ActorKind = 'human' | 'ai' | 'system';
export interface Actor {
  id: string;
  kind: ActorKind;
  name?: string;
}

export type JournalType = 'purchase' | 'sale' | 'bank' | 'cash' | 'general' | 'opening';

export class LedgerError extends Error {
  name: 'LedgerError';
  /** Ex. UNBALANCED_ENTRY, ENTRY_IMMUTABLE, HUMAN_VALIDATION_REQUIRED, FISCAL_YEAR_CLOSED, CHRONOLOGY… */
  code: string;
  details?: unknown;
}

// ——— Plans ———

export interface Labels {
  en: string;
  fr?: string;
}

export interface Account {
  code: string;
  name: string;
  labels?: Labels;
  /** Premier chiffre du code, 1 à 9. */
  class: number;
  /** Type d'origine (asset_receivable, liability_payable, equity…) ou null. */
  type: string | null;
  /** Lettrable. */
  reconcile: boolean;
  custom?: boolean;
}

export interface ChartProfile {
  receivable: string;
  payable: string;
  cash: string;
  resultProfit: string;
  resultLoss: string;
  retainedProfit: string;
  retainedLoss: string;
  exchangeGain: string;
  exchangeLoss: string;
  vatCollected: readonly string[];
  vatDeductible: readonly string[];
  layout: 'syscohada' | 'syscebnl';
}

export interface SourceProvenance {
  repository: string;
  branch: string;
  commit: string;
  license: string;
  copyright: string;
  files: { path: string; url: string; sha256: string }[];
}

export interface AccountGroup {
  prefix: string;
  prefixEnd?: string;
  labels: Labels;
  sourceId: string;
}

export interface Chart {
  id: string;
  name: string;
  source: SourceProvenance | null;
  profile: ChartProfile;
  groups: readonly AccountGroup[];
  accounts: readonly Account[];
}

export type ChartId = 'syscohada' | 'syscebnl';

export function loadChart(id: ChartId): Chart;
export function listCharts(): ChartId[];
export function createChart(options?: {
  id?: string;
  name?: string;
  accounts?: { code: string; name: string; type?: string | null; reconcile?: boolean }[];
  profile?: Partial<ChartProfile>;
}): Chart;

// ——— Taxes ———

export interface TaxRepartition {
  kind: 'base' | 'tax';
  document: 'invoice' | 'refund';
  factorPercent: number;
  account?: string;
  reportTag?: string;
}

export interface Tax {
  id: string;
  name: string;
  nameFr?: string;
  labels: Labels;
  active: boolean;
  /** Taux en pourcentage, texte décimal ("16.0"). */
  amount: string;
  amountType: string;
  use: 'sale' | 'purchase';
  group: string;
  replaces?: string;
  repartition: TaxRepartition[];
}

export interface TaxSet {
  country: string;
  chart: string;
  source: SourceProvenance;
  groups: { id: string; labels: Labels }[];
  taxes: Tax[];
}

export interface TaxComputation {
  base: Minor;
  amount: Minor;
  lines: { account: string; debit: Minor; credit: Minor; tax: { code: string; base: Minor } }[];
}

export const TAX_COUNTRIES: readonly string[];
export function loadTaxes(country?: string, chart?: ChartId): TaxSet;
export function computeTax(base: Minor, tax: Tax, options?: { document?: 'invoice' | 'refund' }): TaxComputation;

// ——— Devises et taux ———

export const CURRENCY_DECIMALS: Readonly<Record<string, number>>;

export interface Currencies {
  codes(): string[];
  decimals(code: string): number;
  format(amount: Minor, code: string): string;
}
export function createCurrencies(extra?: Record<string, number>): Currencies;

export interface RateInput {
  from: string;
  to: string;
  date: DateString;
  /** « 1 from = rate to », décimal positif ("2850.50"). */
  rate: string | number;
}

export interface RateFraction {
  num: bigint;
  den: bigint;
  date: DateString;
  inverted: boolean;
}

export interface RateTable {
  add(rate: RateInput): RateTable;
  rateAt(from: string, to: string, date: DateString): Awaitable<RateFraction>;
}
export function createRateTable(options?: { rates?: RateInput[] }): RateTable;

// ——— Écritures ———

export interface EntryLineInput {
  account: string;
  partner?: string | null;
  label?: string;
  /** Dans la devise de l'écriture. */
  debit?: Minor;
  credit?: Minor;
  tax?: { code: string; base?: Minor };
}

export interface EntryInput {
  journal: string;
  date: DateString;
  label?: string;
  reference?: string;
  /** Devise de saisie ; par défaut la devise de tenue. */
  currency?: string;
  /** Taux manuel « 1 currency = rate devise de tenue » ; sinon la table des taux. */
  rate?: string | number;
  lines: EntryLineInput[];
  /** Justification (utile pour une proposition de l'IA). */
  rationale?: string;
  meta?: Record<string, unknown>;
}

export interface EntryLine {
  /** `${entryId}#${rang}`. */
  id: string;
  account: string;
  partner?: string;
  label: string;
  /** En devise de tenue. */
  debit: Minor;
  credit: Minor;
  currency: string;
  /** Montant signé en devise de la ligne (débit positif). */
  amountCurrency: Minor;
  tax?: { code: string; base: Minor };
  /** Lignes d'origine reprises par une ligne d'à-nouveaux. */
  carriedFrom?: string[];
}

export type EntryStatus = 'draft' | 'posted';

export interface Entry {
  id: string;
  entity: string;
  journal: string;
  fiscalYear: string;
  date: DateString;
  label: string;
  reference?: string;
  currency: string;
  rate?: { value: string; date: DateString; source: 'manual' | 'table'; inverted?: boolean };
  conversionRounding?: Minor;
  lines: EntryLine[];
  totals: { debit: Minor; credit: Minor };
  meta?: Record<string, unknown> & { kind?: 'closing' | 'opening' | 'reversal' | 'exchange-difference' };
  reverses?: string;
  rationale?: string;
  status: EntryStatus;
  /** Ex. VT-2026-000001 ; null tant que brouillon. */
  number: string | null;
  sequence?: number;
  proposedBy: Actor;
  createdAt: string;
  updatedBy?: Actor;
  updatedAt?: string;
  postedBy?: Actor;
  postedAt?: string;
}

export interface EntryFilter {
  status?: EntryStatus;
  journal?: string;
  fiscalYear?: string;
  from?: DateString;
  to?: DateString;
  reverses?: string;
}

// ——— Exercices, tiers, journaux ———

export interface FiscalYear {
  code: string;
  start: DateString;
  end: DateString;
  status: 'open' | 'closed';
  closedAt?: string;
  closedBy?: Actor;
  result?: Minor;
}

export interface Partner {
  id: string;
  name: string;
  kind: string;
  account?: string;
}

export interface Journal {
  code: string;
  type: JournalType;
  name: string;
  account?: string;
}

export interface ClosingResult {
  fiscalYear: string;
  result: Minor;
  closingEntry: Entry | null;
  openingEntry: Entry | null;
  next: string | null;
}

// ——— Lettrage et banque ———

export interface Matching {
  code: string;
  letters: string;
  account: string;
  partner: string | null;
  lineIds: string[];
  status: 'full' | 'partial';
  residual: Minor;
  createdAt: string;
  createdBy: Actor;
  exchangeEntryId?: string;
}

export interface OpenItem {
  lineId: string;
  entryId: string;
  number: string;
  date: DateString;
  label: string;
  partner: string | null;
  debit: Minor;
  credit: Minor;
  currency: string;
  amountCurrency: Minor;
  partialMatching?: string;
}

export interface StatementLineInput {
  id?: string;
  date: DateString;
  label?: string;
  /** Signé : + entrée d'argent, − sortie. */
  amount: Minor;
  reference?: string;
}

export interface StatementLine {
  id: string;
  account: string;
  date: DateString;
  label: string;
  amount: Minor;
  reference?: string;
  matchedLineIds: string[];
  matchGroup?: string | null;
}

export interface BankReconciliation {
  account: string;
  date: DateString;
  bookBalance: Minor;
  statementBalance: Minor;
  unmatchedBook: { lineId: string; number: string; date: DateString; label: string; amount: Minor }[];
  unmatchedStatement: StatementLine[];
  reconciledBalance: Minor;
  difference: Minor;
  balanced: boolean;
}

// ——— États ———

export interface PeriodOptions {
  fiscalYear?: string;
  from?: DateString;
  to?: DateString;
}

export interface TrialBalanceRow {
  account: string;
  name: string;
  class: number;
  openingDebit: Minor;
  openingCredit: Minor;
  debit: Minor;
  credit: Minor;
  closingDebit: Minor;
  closingCredit: Minor;
}
type TrialTotals = Omit<TrialBalanceRow, 'account' | 'name' | 'class'>;

export interface TrialBalance {
  fiscalYear: string;
  from: DateString;
  to: DateString;
  rows: TrialBalanceRow[];
  classes: (TrialTotals & { class: number })[];
  totals: TrialTotals;
  balanced: boolean;
}

export interface LedgerAccount {
  account: string;
  name: string;
  partner?: string | null;
  opening: Minor;
  closing: Minor;
  totalDebit: Minor;
  totalCredit: Minor;
  lines: {
    lineId: string;
    entryId: string;
    number: string;
    journal: string;
    date: DateString;
    label: string;
    partner: string | null;
    currency: string;
    amountCurrency: Minor;
    debit: Minor;
    credit: Minor;
    balance: Minor;
  }[];
}

export interface StatementAccount {
  account: string | null;
  name: string;
  amount: Minor;
  contra?: boolean;
}

export interface BalanceSheet {
  fiscalYear: string;
  date: DateString;
  currency: string;
  layout: string;
  assets: { code: string; label: string; total?: boolean; gross?: Minor; depreciation?: Minor; net: Minor; accounts?: StatementAccount[] }[];
  liabilities: { code: string; label: string; total?: boolean; amount: Minor; accounts?: StatementAccount[] }[];
  unclassified: { assets: StatementAccount[]; liabilities: StatementAccount[] };
  totals: { assets: Minor; liabilities: Minor };
  totalCodes: { assets: string; liabilities: string };
  result: Minor;
  balanced: boolean;
}

export interface IncomeStatement {
  fiscalYear: string;
  from: DateString;
  to: DateString;
  currency: string;
  layout: string;
  lines: { code: string; label: string; nature?: 'income' | 'expense'; aggregate?: boolean; amount: Minor; accounts?: StatementAccount[] }[];
  unclassified: StatementAccount[];
  totals: { income: Minor; expenses: Minor };
  result: Minor;
  resultCode: string;
}

export interface VatReport {
  from: DateString;
  to: DateString;
  currency: string;
  collected: Minor;
  deductible: Minor;
  /** Positif : TVA à reverser ; négatif : crédit de TVA. */
  due: Minor;
  accounts: { account: string; name: string; kind: 'collected' | 'deductible'; amount: Minor }[];
  taxes: { code: string; base: Minor; amount: Minor }[];
}

// ——— Stockage ———

/** Accès aux données d'UNE entité, à l'intérieur d'une transaction ou d'une lecture. */
export interface LedgerStoreAccess {
  getAccount(code: string): Promise<Account | null>;
  listAccounts(): Promise<Account[]>;
  insertAccount(account: Account): Promise<void>;
  getPartner(id: string): Promise<Partner | null>;
  listPartners(): Promise<Partner[]>;
  insertPartner(partner: Partner): Promise<void>;
  getJournal(code: string): Promise<Journal | null>;
  listJournals(): Promise<Journal[]>;
  insertJournal(journal: Journal): Promise<void>;
  /** Triés par date de début. */
  listFiscalYears(): Promise<FiscalYear[]>;
  insertFiscalYear(fiscalYear: FiscalYear): Promise<void>;
  updateFiscalYear(code: string, patch: Partial<FiscalYear>): Promise<boolean>;
  insertEntry(entry: Entry): Promise<void>;
  getEntry(id: string): Promise<Entry | null>;
  /** Triées par date puis ordre de création. */
  listEntries(filter?: EntryFilter): Promise<Entry[]>;
  /** N'agit que sur un brouillon ; false sinon. */
  replaceDraft(id: string, entry: Entry): Promise<boolean>;
  deleteDraft(id: string): Promise<boolean>;
  markPosted(id: string, posting: { number: string; sequence?: number; postedAt?: string; postedBy?: Actor }): Promise<boolean>;
  /** Verrouille la ligne de séquence (FOR UPDATE en SQL). */
  getSequence(journal: string, fiscalYear: string): Promise<{ last: number; lastDate: DateString | null } | null>;
  setSequence(journal: string, fiscalYear: string, sequence: { last: number; lastDate: DateString | null }): Promise<void>;
  insertMatching(matching: Matching): Promise<void>;
  deleteMatching(code: string): Promise<boolean>;
  listMatchings(filter?: { account?: string; lineId?: string }): Promise<Matching[]>;
  insertStatementLines(lines: StatementLine[]): Promise<void>;
  listStatementLines(filter?: { account?: string }): Promise<StatementLine[]>;
  updateStatementLine(id: string, patch: Partial<StatementLine>): Promise<boolean>;
}

/**
 * Contrat de stockage. `transaction` est tout ou rien et sérialisée par
 * entité ; `read` sert aux lectures.
 */
export interface LedgerStore {
  kind: string;
  transaction<T>(entityId: string, fn: (tx: LedgerStoreAccess) => Promise<T>): Promise<T>;
  read<T>(entityId: string, fn: (reader: LedgerStoreAccess) => Promise<T>): Promise<T>;
}

export function createMemoryLedgerStore(): LedgerStore;

export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  connect(): Promise<{ query(text: string, values?: unknown[]): Promise<{ rows: any[] }>; release(): void }>;
}

export function createPostgresLedgerStore(options: { pool: PgPoolLike; tablePrefix?: string }): LedgerStore;
/** Au format de createPostgresMigrationRunner (@astratra/store-postgres). */
export function ledgerPostgresMigrations(tablePrefix?: string): { id: string; up(client: { query(text: string, values?: unknown[]): Promise<unknown> }): Promise<void> }[];

// ——— Grand livre ———

export interface LedgerHooks {
  /** Après chaque proposition (brouillon) : notifier un humain, par exemple. */
  onProposal?(entry: Entry, actor: Actor): Awaitable<void>;
  /** Avant validation, dans la transaction : lever une erreur bloque la validation. */
  beforeValidate?(entry: Entry, actor: Actor): Awaitable<void>;
  afterValidate?(entry: Entry, actor: Actor): Awaitable<void>;
  afterClose?(result: ClosingResult, actor: Actor): Awaitable<void>;
}

export interface LedgerOptions {
  entity: {
    id: string;
    /** Plan livré ou objet createChart(). Défaut : syscohada. */
    chart?: ChartId | Chart;
    /** Devise de tenue. Défaut : CDF. */
    currency?: string;
  };
  store?: LedgerStore;
  rates?: RateTable;
  currencies?: Record<string, number>;
  hooks?: LedgerHooks;
  now?: () => Date;
}

export interface Ledger {
  readonly entity: { id: string; currency: string; chart: string };
  readonly chart: Chart;
  readonly currencies: Currencies;

  getAccount(code: string): Promise<Account>;
  listAccounts(options?: { class?: number }): Promise<Account[]>;
  addAccount(account: { code: string; name: string; type?: string | null; reconcile?: boolean }): Promise<Account>;
  addPartner(partner: { id: string; name: string; kind?: 'customer' | 'supplier' | string; account?: string }): Promise<Partner>;
  getPartner(id: string): Promise<Partner | null>;
  listPartners(): Promise<Partner[]>;
  addJournal(journal: { code: string; type: Exclude<JournalType, 'opening'>; name?: string; account?: string }): Promise<Journal>;
  listJournals(): Promise<Journal[]>;

  openFiscalYear(fiscalYear: { code: string; start: DateString; end: DateString }): Promise<FiscalYear>;
  listFiscalYears(): Promise<FiscalYear[]>;
  closeFiscalYear(code: string, options: {
    actor: Actor;
    next?: string;
    allocateResult?: boolean;
    carryForward?: boolean;
    closingJournal?: string;
  }): Promise<ClosingResult>;

  propose(entry: EntryInput, options: { actor: Actor }): Promise<Entry>;
  updateDraft(id: string, entry: EntryInput, options: { actor: Actor }): Promise<Entry>;
  discardDraft(id: string, options: { actor: Actor }): Promise<true>;
  validate(id: string, options: { actor: Actor }): Promise<Entry>;
  post(entry: EntryInput, options: { actor: Actor }): Promise<Entry>;
  reverse(id: string, options: { actor: Actor; date?: DateString; label?: string }): Promise<Entry>;
  getEntry(id: string): Promise<Entry | null>;
  listEntries(filter?: EntryFilter): Promise<Entry[]>;

  reconcile(lineIds: string[], options: { actor: Actor; date?: DateString; journal?: string }): Promise<Matching>;
  unreconcile(code: string, options: { actor: Actor }): Promise<true>;
  listMatchings(filter?: { account?: string; lineId?: string }): Promise<Matching[]>;
  openItems(options: { account: string; partner?: string | null }): Promise<OpenItem[]>;

  importStatement(statement: { account: string; lines: StatementLineInput[] }, options: { actor: Actor }): Promise<{ imported: number; skipped: number; lines: StatementLine[] }>;
  matchStatement(statementLineIds: string[], lineIds: string[], options: { actor: Actor }): Promise<{ group: string; statementLineIds: string[]; lineIds: string[]; amount: Minor }>;
  unmatchStatement(statementLineId: string, options: { actor: Actor }): Promise<true>;
  autoMatchStatement(account: string, options: { actor: Actor; toleranceDays?: number }): Promise<{ matched: number }>;
  bankReconciliation(account: string, options: { date: DateString; statementBalance?: Minor }): Promise<BankReconciliation>;

  journalReport(journal: string, options?: PeriodOptions): Promise<{ journal: string; fiscalYear: string; entries: Entry[]; totals: { debit: Minor; credit: Minor } }>;
  generalLedger(options?: PeriodOptions & { accounts?: string[]; partner?: string | null; byPartner?: boolean }): Promise<{ fiscalYear: string; from: DateString; to: DateString; accounts: LedgerAccount[] }>;
  trialBalance(options?: PeriodOptions & { includeClosing?: boolean }): Promise<TrialBalance>;
  balanceSheet(options?: { fiscalYear?: string; to?: DateString }): Promise<BalanceSheet>;
  incomeStatement(options?: PeriodOptions): Promise<IncomeStatement>;
  vatReport(options: { from: DateString; to: DateString; collected?: readonly string[]; deductible?: readonly string[] }): Promise<VatReport>;
}

export const JOURNAL_TYPES: readonly JournalType[];
export const ACTOR_KINDS: readonly ActorKind[];
export function createLedger(options: LedgerOptions): Ledger;
