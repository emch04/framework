'use strict';
const { prefixOf, requireQueryable } = require('./util');

const DEFAULT_PREFIX = 'astratra_tools';
const names = (options) => {
  const p = prefixOf(options, DEFAULT_PREFIX);
  return { totals: `"${p}_budget_totals"`, entries: `"${p}_budget_entries"`, raw: p };
};

/** SQL that creates the tool budget tables. Idempotent: run it at every start or in a migration. */
function postgresToolBudgetSchema(options) {
  const t = names(options);
  return `CREATE TABLE IF NOT EXISTS ${t.totals} (
  scope text NOT NULL,
  period text NOT NULL,
  spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
  PRIMARY KEY (scope, period)
);
CREATE TABLE IF NOT EXISTS ${t.entries} (
  scope text NOT NULL,
  id text NOT NULL,
  period text NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 0),
  at timestamptz NOT NULL,
  PRIMARY KEY (scope, id)
);`;
}

/**
 * Tool budget store on PostgreSQL. `db` is any `{ query(sql, params) }`. A
 * consumption is added by ONE statement (entry and total together), so it is
 * atomic and idempotent without a transaction. Amounts are bigint integers.
 */
function createPostgresToolBudgetStore(db, options = {}) {
  requireQueryable(db);
  const t = names(options);
  return {
    async getSpent(scope, period) {
      const row = (await db.query(`SELECT spent::text AS spent FROM ${t.totals} WHERE scope = $1 AND period = $2`, [scope, period])).rows[0];
      return row ? Number(row.spent) : 0;
    },
    async addSpend({ scope, period, id, amount, at }) {
      const row = (await db.query(
        `WITH ins AS (
           INSERT INTO ${t.entries} (scope, id, period, amount, at) VALUES ($1, $2, $3, $4, $5::timestamptz)
           ON CONFLICT (scope, id) DO NOTHING RETURNING amount
         ), upd AS (
           INSERT INTO ${t.totals} (scope, period, spent) SELECT $1, $3, amount FROM ins
           ON CONFLICT (scope, period) DO UPDATE SET spent = ${t.totals}.spent + EXCLUDED.spent RETURNING spent
         )
         SELECT (SELECT count(*) FROM ins)::int AS added,
                coalesce((SELECT spent FROM upd), (SELECT spent FROM ${t.totals} WHERE scope = $1 AND period = $3), 0)::text AS spent`,
        [scope, id, period, amount, at])).rows[0];
      return { added: Number(row.added) > 0, spent: Number(row.spent) };
    }
  };
}

module.exports = { postgresToolBudgetSchema, createPostgresToolBudgetStore };
