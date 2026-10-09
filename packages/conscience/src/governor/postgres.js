'use strict';
const { prefixOf, requireQueryable } = require('./util');
const { boundedLimit } = require('./stores');

const DEFAULT_PREFIX = 'astratra_governor';
const names = (options) => {
  const p = prefixOf(options, DEFAULT_PREFIX);
  return { proposals: `"${p}_proposals"`, audit: `"${p}_audit"`, spend: `"${p}_spend"`, controls: `"${p}_controls"`, raw: p };
};

/** SQL that creates the governor tables. Idempotent: run it at every start or in a migration. */
function postgresGovernorSchema(options) {
  const t = names(options);
  return `CREATE TABLE IF NOT EXISTS ${t.proposals} (
  organisation_id text NOT NULL,
  id text NOT NULL,
  status text NOT NULL CHECK (status IN ('rejected', 'pending_approval', 'approved', 'declined')),
  fingerprint text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (organisation_id, id)
);
CREATE INDEX IF NOT EXISTS "${t.raw}_proposals_status_idx" ON ${t.proposals} (organisation_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS ${t.audit} (
  seq bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  organisation_id text,
  proposal_id text,
  at timestamptz NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS "${t.raw}_audit_org_idx" ON ${t.audit} (organisation_id, seq DESC);
CREATE TABLE IF NOT EXISTS ${t.spend} (
  organisation_id text NOT NULL,
  id text NOT NULL,
  agent_id text NOT NULL,
  cycle_id text,
  cost double precision NOT NULL CHECK (cost >= 0),
  at timestamptz NOT NULL,
  PRIMARY KEY (organisation_id, id)
);
CREATE INDEX IF NOT EXISTS "${t.raw}_spend_at_idx" ON ${t.spend} (organisation_id, at);
CREATE TABLE IF NOT EXISTS ${t.controls} (
  key text PRIMARY KEY,
  data jsonb NOT NULL
);`;
}

const json = (row) => (row ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : null);

/**
 * Governor store on PostgreSQL. `db` is any `{ query(sql, params) }`; when it
 * also has `connect()` (a `pg` Pool), spending is reserved inside a
 * transaction under an advisory lock per organisation, so two concurrent
 * spends never both pass a budget. Every value is a SQL parameter.
 */
function createPostgresGovernorStore(db, options) {
  requireQueryable(db);
  const t = names(options);

  async function withTransaction(fn) {
    if (typeof db.connect !== 'function') return fn(db);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return {
    async putProposal(record) {
      const inserted = await db.query(
        `INSERT INTO ${t.proposals} (organisation_id, id, status, fingerprint, data, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
         ON CONFLICT (organisation_id, id) DO NOTHING RETURNING data`,
        [record.organisationId, record.id, record.status, record.fingerprint, JSON.stringify(record), record.createdAt]);
      if (inserted.rows.length) return { record: json(inserted.rows[0]), created: true };
      return { record: await this.getProposal(record.organisationId, record.id), created: false };
    },
    async getProposal(organisationId, id) {
      return json((await db.query(`SELECT data FROM ${t.proposals} WHERE organisation_id = $1 AND id = $2`, [organisationId, id])).rows[0]);
    },
    async transitionProposal(organisationId, id, fromStatus, patch) {
      const result = await db.query(
        `UPDATE ${t.proposals} SET status = $4, data = data || $5::jsonb WHERE organisation_id = $1 AND id = $2 AND status = $3 RETURNING data`,
        [organisationId, id, fromStatus, patch.status, JSON.stringify(patch)]);
      return json(result.rows[0]);
    },
    async listProposals(filter = {}) {
      const params = [filter.organisationId];
      let sql = `SELECT data FROM ${t.proposals} WHERE organisation_id = $1`;
      if (filter.status != null) { params.push(filter.status); sql += ` AND status = $${params.length}`; }
      params.push(boundedLimit(filter.limit));
      sql += ` ORDER BY created_at DESC, id LIMIT $${params.length}`;
      return (await db.query(sql, params)).rows.map(json);
    },
    async appendAudit(entry) {
      await db.query(`INSERT INTO ${t.audit} (id, organisation_id, proposal_id, at, data) VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)`,
        [entry.id, entry.organisationId, entry.proposalId, entry.at, JSON.stringify(entry)]);
      return entry;
    },
    async listAudit(filter = {}) {
      const params = []; const parts = [];
      if (filter.organisationId !== undefined) {
        if (filter.organisationId === null) parts.push('organisation_id IS NULL');
        else { params.push(filter.organisationId); parts.push(`organisation_id = $${params.length}`); }
      }
      if (filter.proposalId != null) { params.push(filter.proposalId); parts.push(`proposal_id = $${params.length}`); }
      params.push(boundedLimit(filter.limit));
      const where = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
      return (await db.query(`SELECT data FROM ${t.audit}${where} ORDER BY seq DESC LIMIT $${params.length}`, params)).rows.map(json);
    },
    async reserveSpend(entry, limits) {
      return withTransaction(async (q) => {
        await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${t.raw}:${entry.organisationId}`]);
        const sums = async () => {
          const row = (await q.query(
            `SELECT coalesce(sum(cost) FILTER (WHERE $2::text IS NOT NULL AND cycle_id = $2), 0)::float8 AS cycle,
                    coalesce(sum(cost) FILTER (WHERE at >= to_timestamp($3::double precision / 1000) AND agent_id = $4), 0)::float8 AS agent,
                    coalesce(sum(cost) FILTER (WHERE at >= to_timestamp($3::double precision / 1000)), 0)::float8 AS organisation
             FROM ${t.spend} WHERE organisation_id = $1`,
            [entry.organisationId, entry.cycleId, limits.since, entry.agentId])).rows[0];
          return { cycle: Number(row.cycle), agent: Number(row.agent), organisation: Number(row.organisation) };
        };
        const exists = (await q.query(`SELECT 1 FROM ${t.spend} WHERE organisation_id = $1 AND id = $2`, [entry.organisationId, entry.id])).rows.length > 0;
        if (exists) return { reserved: true, created: false, totals: await sums() };
        const totals = await sums();
        const fits = (entry.cycleId == null || totals.cycle + entry.cost <= limits.perCycle)
          && totals.agent + entry.cost <= limits.perAgent
          && totals.organisation + entry.cost <= limits.perOrganisation;
        if (!fits) return { reserved: false, created: false, totals };
        await q.query(`INSERT INTO ${t.spend} (organisation_id, id, agent_id, cycle_id, cost, at) VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000))`,
          [entry.organisationId, entry.id, entry.agentId, entry.cycleId, entry.cost, entry.at]);
        return { reserved: true, created: true, totals: await sums() };
      });
    },
    async getControl(key) {
      return json((await db.query(`SELECT data FROM ${t.controls} WHERE key = $1`, [key])).rows[0]);
    },
    async setControl(key, value) {
      await db.query(`INSERT INTO ${t.controls} (key, data) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`, [key, JSON.stringify(value)]);
      return value;
    }
  };
}

module.exports = { postgresGovernorSchema, createPostgresGovernorStore };
