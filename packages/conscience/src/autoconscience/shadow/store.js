'use strict';
/*
 * Storage of the shadow mode (P4): one ShadowRun per sampled request. A memory
 * store and a PostgreSQL store with the same contract. Every read and write is
 * scoped by organisation; a run is written once (idempotent by id); runs of one
 * person are removed with `removeShadowRuns` (erasure).
 */
const { copy, prefixOf, requireQueryable } = require('../../governor/util');
const { ConscienceError } = require('../../errors');

const MAX_LIMIT = 10000;
const limitOf = (value) => Math.min(Math.max(Number(value) || 1000, 1), MAX_LIMIT);
const DEFAULT_PREFIX = 'astratra_shadow';
const keyOf = (organisationId, id) => `${organisationId}\u0000${id}`;
const SHADOW_STORE_METHODS = ['putShadowRun', 'getShadowRun', 'listShadowRuns', 'removeShadowRuns'];

/** Eraser for createConscience({ erasers: [...] }): removes the shadow runs of a person with the rest of their data. */
function shadowEraser(store) {
  if (!store || typeof store.removeShadowRuns !== 'function') throw new ConscienceError('store_invalid', 'A shadow store is required.');
  return async ({ organisationId, userId }) => ({ name: 'shadow_runs', count: await store.removeShadowRuns({ organisationId, userId }) });
}

function createMemoryShadowStore() {
  const runs = new Map();
  return {
    async putShadowRun(record) {
      const key = keyOf(record.organisationId, record.id);
      if (runs.has(key)) return { record: copy(runs.get(key)), created: false };
      runs.set(key, copy(record));
      return { record: copy(record), created: true };
    },
    async getShadowRun(organisationId, id) { return copy(runs.get(keyOf(organisationId, id)) ?? null); },
    async listShadowRuns(filter = {}) {
      return [...runs.values()]
        .filter((row) => row.organisationId === filter.organisationId && (filter.shadowId === undefined || row.shadowId === filter.shadowId)
          && (filter.userId === undefined || row.userId === filter.userId))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
        .slice(0, limitOf(filter.limit)).map(copy);
    },
    async removeShadowRuns({ organisationId, userId }) {
      let count = 0;
      for (const [key, row] of runs) if (row.organisationId === organisationId && row.userId === userId) { runs.delete(key); count += 1; }
      return count;
    }
  };
}

/** SQL that creates the shadow table. Idempotent. */
function postgresShadowSchema(options) {
  const p = prefixOf(options, DEFAULT_PREFIX);
  return `CREATE TABLE IF NOT EXISTS "${p}_runs" (
  organisation_id text NOT NULL,
  id text NOT NULL,
  shadow_id text NOT NULL,
  user_id text,
  created_at timestamptz NOT NULL,
  envelope jsonb NOT NULL,
  PRIMARY KEY (organisation_id, id)
);
CREATE INDEX IF NOT EXISTS "${p}_runs_shadow_idx" ON "${p}_runs" (organisation_id, shadow_id, created_at);
CREATE INDEX IF NOT EXISTS "${p}_runs_user_idx" ON "${p}_runs" (organisation_id, user_id);`;
}

const read = (row) => (row ? (typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope) : null);

/** Shadow store on PostgreSQL. `db` is any `{ query(sql, params) }`; every value is a parameter. */
function createPostgresShadowStore(db, options) {
  requireQueryable(db);
  const p = prefixOf(options, DEFAULT_PREFIX);
  const table = `"${p}_runs"`;
  return {
    async putShadowRun(record) {
      const inserted = await db.query(
        `INSERT INTO ${table} (organisation_id, id, shadow_id, user_id, created_at, envelope)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb) ON CONFLICT (organisation_id, id) DO NOTHING RETURNING envelope`,
        [record.organisationId, record.id, record.shadowId, record.userId ?? null, record.createdAt, JSON.stringify(record)]);
      if (inserted.rows.length) return { record: read(inserted.rows[0]), created: true };
      return { record: await this.getShadowRun(record.organisationId, record.id), created: false };
    },
    async getShadowRun(organisationId, id) {
      return read((await db.query(`SELECT envelope FROM ${table} WHERE organisation_id = $1 AND id = $2`, [organisationId, id])).rows[0]);
    },
    async listShadowRuns(filter = {}) {
      const params = [filter.organisationId];
      const parts = ['organisation_id = $1'];
      if (filter.shadowId !== undefined) { params.push(filter.shadowId); parts.push(`shadow_id = $${params.length}`); }
      if (filter.userId !== undefined) { if (filter.userId === null) parts.push('user_id IS NULL'); else { params.push(filter.userId); parts.push(`user_id = $${params.length}`); } }
      params.push(limitOf(filter.limit));
      return (await db.query(`SELECT envelope FROM ${table} WHERE ${parts.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`, params)).rows.map(read);
    },
    async removeShadowRuns({ organisationId, userId }) {
      const result = await db.query(`DELETE FROM ${table} WHERE organisation_id = $1 AND user_id = $2`, [organisationId, userId]);
      return result.rowCount ?? 0;
    }
  };
}

module.exports = { createMemoryShadowStore, createPostgresShadowStore, postgresShadowSchema, shadowEraser, SHADOW_STORE_METHODS, SHADOW_RUN_LIMIT: MAX_LIMIT };
