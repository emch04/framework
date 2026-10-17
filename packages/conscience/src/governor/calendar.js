'use strict';
const { GovernorError, isNonEmptyString } = require('./util');

/*
 * Calendar budget: consumption counted per calendar period (day or month) in a
 * given time zone, with a cap in whole units of your choice (cents, tokens...).
 * No floating point money: amounts and caps are safe integers.
 */

const PERIODS = Object.freeze(['day', 'month']);
const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try { formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (_error) {
      throw new GovernorError('budget_invalid', `Unknown time zone: ${timeZone}.`);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The calendar period of an instant, in a time zone: "2026-10" (month) or
 * "2026-10-31" (day). `period` may also be a function (instant, timeZone) => key.
 */
function calendarPeriodKey(at, { period = 'month', timeZone = 'UTC' } = {}) {
  const date = new Date(at instanceof Date ? at.getTime() : at);
  if (Number.isNaN(date.getTime())) throw new GovernorError('budget_invalid', 'The instant of a budget period must be a valid date.');
  if (typeof period === 'function') {
    const key = period(date, timeZone);
    if (!isNonEmptyString(key)) throw new GovernorError('budget_invalid', 'A custom period must return a non-empty string.');
    return key;
  }
  if (!PERIODS.includes(period)) throw new GovernorError('budget_invalid', `period must be ${PERIODS.join(' or ')} or a function.`);
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return period === 'month' ? `${parts.year}-${parts.month}` : `${parts.year}-${parts.month}-${parts.day}`;
}

const isAmount = (value) => Number.isSafeInteger(value) && value >= 0;

/** Budget store kept in memory: lost when the process exits. */
function createMemoryToolBudgetStore() {
  const totals = new Map();
  const entries = new Set();
  const totalKey = (scope, period) => `${scope}\u0000${period}`;
  return {
    async getSpent(scope, period) { return totals.get(totalKey(scope, period)) ?? 0; },
    /** Idempotent on (scope, id): a replay adds nothing. */
    async addSpend({ scope, period, id, amount }) {
      const entry = `${scope}\u0000${id}`;
      const key = totalKey(scope, period);
      if (entries.has(entry)) return { added: false, spent: totals.get(key) ?? 0 };
      entries.add(entry);
      totals.set(key, (totals.get(key) ?? 0) + amount);
      return { added: true, spent: totals.get(key) };
    }
  };
}

/**
 * Calendar budget over a store { getSpent(scope, period), addSpend({ scope,
 * period, id, amount, at }) }. `limit` is the default cap; a call may pass its own.
 * A store with getSpent() only is a supported case: the budget reads a consumption kept elsewhere.
 */
function createCalendarBudget(options = {}) {
  const { period = 'month', timeZone = 'UTC', scope: defaultScope = 'default', limit: defaultLimit } = options;
  const store = options.store ?? createMemoryToolBudgetStore();
  if (typeof store.getSpent !== 'function') throw new GovernorError('budget_invalid', 'The budget store is missing getSpent().');
  /* A store with getSpent() only is read-only: the consumption is counted elsewhere (your own table of costs),
     the budget only reads it before each call. record() then refuses with budget_read_only. */
  const readOnly = typeof store.addSpend !== 'function';
  if (!readOnly && options.readOnly === true) throw new GovernorError('budget_invalid', 'readOnly: true but the store has addSpend().');
  if (defaultLimit !== undefined && defaultLimit !== null && !isAmount(defaultLimit)) throw new GovernorError('budget_invalid', 'limit must be an integer >= 0.');
  const now = options.now ?? Date.now;
  calendarPeriodKey(now(), { period, timeZone }); // fails now, not at the first call, on a wrong period or time zone

  const keyOf = (at) => calendarPeriodKey(at ?? now(), { period, timeZone });

  /** Where the budget stands, and whether a call of `estimate` units still fits. Read before each call. */
  async function check({ scope = defaultScope, limit = defaultLimit, estimate = 0, at } = {}) {
    if (limit !== undefined && limit !== null && !isAmount(limit)) throw new GovernorError('budget_invalid', 'limit must be an integer >= 0.');
    if (!isAmount(estimate)) throw new GovernorError('budget_invalid', 'estimate must be an integer >= 0.');
    const key = keyOf(at);
    const spent = await store.getSpent(scope, key);
    if (limit === undefined || limit === null) return { allowed: true, exceeded: false, scope, period: key, spent, limit: null, remaining: null };
    return { allowed: spent < limit && spent + estimate <= limit, exceeded: spent >= limit, scope, period: key, spent, limit, remaining: Math.max(0, limit - spent) };
  }

  /** Counts a consumption in the period of its instant. `id` makes the call safe to repeat. */
  async function record({ scope = defaultScope, amount, id, at } = {}) {
    if (readOnly) throw new GovernorError('budget_read_only', 'This budget reads a consumption counted elsewhere: record it in your own store.');
    if (!isAmount(amount)) throw new GovernorError('budget_invalid', 'amount must be an integer >= 0 (whole units, no fractions).');
    if (!isNonEmptyString(id)) throw new GovernorError('budget_invalid', 'A consumption needs a stable id (idempotency).');
    const instant = at ?? now();
    const key = keyOf(instant);
    const result = await store.addSpend({ scope, period: key, id, amount, at: new Date(instant).toISOString() });
    return { added: result.added, scope, period: key, spent: result.spent };
  }

  return Object.freeze({ check, record, readOnly, periodKey: keyOf, period: typeof period === 'function' ? 'custom' : period, timeZone });
}

module.exports = { PERIODS, calendarPeriodKey, createMemoryToolBudgetStore, createCalendarBudget, isAmount };
