/**
 * @astratra/ledger — comptabilité en partie double, plans OHADA.
 */
const { createLedger, JOURNAL_TYPES, ACTOR_KINDS } = require('./ledger');
const { LedgerError, createCurrencies, createRateTable, DECIMALES_PAR_DEFAUT } = require('./money');
const { loadChart, createChart, listCharts } = require('./charts');
const { loadTaxes, computeTax, TAX_COUNTRIES } = require('./taxes');
const { createMemoryLedgerStore } = require('./memoryStore');
const { createPostgresLedgerStore, ledgerPostgresMigrations } = require('./postgresStore');

module.exports = {
  createLedger,
  createMemoryLedgerStore,
  createPostgresLedgerStore,
  ledgerPostgresMigrations,
  loadChart,
  createChart,
  listCharts,
  loadTaxes,
  computeTax,
  createRateTable,
  createCurrencies,
  LedgerError,
  CURRENCY_DECIMALS: DECIMALES_PAR_DEFAUT,
  JOURNAL_TYPES,
  ACTOR_KINDS,
  TAX_COUNTRIES
};
