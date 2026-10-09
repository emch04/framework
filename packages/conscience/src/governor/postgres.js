'use strict';
const { prefixOf, requireQueryable } = require('./util');
const { boundedLimit } = require('./stores');

const DEFAULT_PREFIX = 'astratra_governor';
const names = (options) => {
  const p = prefixOf(options, DEFAULT_PREFIX);
  return { proposals: `"${p}_proposals"`, audit: `"${p}_audit"`, spend: `"${p}_spend"`, controls: `"${p}_controls"`, objects: `"${p}_objects"`, versions: `"${p}_versions"`, findings: `"${p}_findings"`, raw: p };
};

/** SQL that creates the governor tables. Idempotent: run it at every start or in a migration. */
function postgresGovernorSchema(options) {
  const t = names(options);
  return `CREATE TABLE IF NOT EXISTS ${t.proposals} (
  organisation_id text NOT NULL,
  id text NOT NULL,
  status text NOT NULL CHECK (status IN ('rejected', 'pending_approval', 'approved', 'declined', 'expired')),
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
);
CREATE TABLE IF NOT EXISTS ${t.objects} (
  organisation_id text NOT NULL,
  kind text NOT NULL,
  id text NOT NULL,
  revision integer NOT NULL,
  has_candidate boolean NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (organisation_id, kind, id)
);
CREATE INDEX IF NOT EXISTS "${t.raw}_objects_candidate_idx" ON ${t.objects} (has_candidate) WHERE has_candidate;
CREATE TABLE IF NOT EXISTS ${t.versions} (
  organisation_id text NOT NULL,
  kind text NOT NULL,
  id text NOT NULL,
  version_id text NOT NULL,
  number integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (organisation_id, kind, id, version_id)
);
CREATE TABLE IF NOT EXISTS ${t.findings} (
  organisation_id text NOT NULL,
  id text NOT NULL,
  received_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (organisation_id, id)
);
CREATE INDEX IF NOT EXISTS "${t.raw}_findings_at_idx" ON ${t.findings} (organisation_id, received_at DESC);`;
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
    async transitionProposal(organisationId, id, fromStatus, patch, guard) {
      const params = [organisationId, id, fromStatus, patch.status ?? fromStatus, JSON.stringify(patch)];
      let sql = `UPDATE ${t.proposals} SET status = $4, data = data || $5::jsonb WHERE organisation_id = $1 AND id = $2 AND status = $3`;
      if (guard?.approvals !== undefined) { params.push(guard.approvals); sql += ` AND jsonb_array_length(coalesce(data->'approvals', '[]'::jsonb)) = $${params.length}`; }
      return json((await db.query(`${sql} RETURNING data`, params)).rows[0]);
    },
    async listProposals(filter = {}) {
      const params = [filter.organisationId];
      let sql = `SELECT data FROM ${t.proposals} WHERE organisation_id = $1`;
      if (filter.status != null) { params.push(filter.status); sql += ` AND status = $${params.length}`; }
      if (filter.statuses != null) { params.push(filter.statuses); sql += ` AND status = ANY($${params.length}::text[])`; }
      if (filter.since != null) { params.push(filter.since); sql += ` AND coalesce((data->>'decidedAt')::timestamptz, created_at) >= $${params.length}::timestamptz`; }
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
      if (filter.actions != null) { params.push(filter.actions); parts.push(`data->>'action' = ANY($${params.length}::text[])`); }
      if (filter.since != null) { params.push(filter.since); parts.push(`at >= $${params.length}::timestamptz`); }
      if (filter.objectKind != null) { params.push(filter.objectKind); parts.push(`data->>'objectKind' = $${params.length}`); }
      if (filter.objectId != null) { params.push(filter.objectId); parts.push(`data->>'objectId' = $${params.length}`); }
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
    },

    async getObject(organisationId, kind, id) {
      return json((await db.query(`SELECT data FROM ${t.objects} WHERE organisation_id = $1 AND kind = $2 AND id = $3`, [organisationId, kind, id])).rows[0]);
    },
    async createObject(state) {
      const inserted = await db.query(
        `INSERT INTO ${t.objects} (organisation_id, kind, id, revision, has_candidate, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (organisation_id, kind, id) DO NOTHING RETURNING data`,
        [state.organisationId, state.kind, state.id, state.revision, state.candidate != null, JSON.stringify(state)]);
      if (inserted.rows.length) return { record: json(inserted.rows[0]), created: true };
      return { record: await this.getObject(state.organisationId, state.kind, state.id), created: false };
    },
    async updateObject(organisationId, kind, id, expectedRevision, next) {
      return json((await db.query(
        `UPDATE ${t.objects} SET revision = $5, has_candidate = $6, data = $7::jsonb
         WHERE organisation_id = $1 AND kind = $2 AND id = $3 AND revision = $4 RETURNING data`,
        [organisationId, kind, id, expectedRevision, next.revision, next.candidate != null, JSON.stringify(next)])).rows[0]);
    },
    async listObjects(filter = {}) {
      const params = []; const parts = [];
      if (filter.organisationId != null) { params.push(filter.organisationId); parts.push(`organisation_id = $${params.length}`); }
      if (filter.kind != null) { params.push(filter.kind); parts.push(`kind = $${params.length}`); }
      if (filter.hasCandidate) parts.push('has_candidate');
      params.push(boundedLimit(filter.limit));
      const where = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
      return (await db.query(`SELECT data FROM ${t.objects}${where} ORDER BY organisation_id, kind, id LIMIT $${params.length}`, params)).rows.map(json);
    },
    async putVersion(record) {
      const inserted = await db.query(
        `INSERT INTO ${t.versions} (organisation_id, kind, id, version_id, number, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (organisation_id, kind, id, version_id) DO NOTHING RETURNING data`,
        [record.organisationId, record.kind, record.id, record.versionId, record.number, JSON.stringify(record)]);
      if (inserted.rows.length) return { record: json(inserted.rows[0]), created: true };
      return { record: await this.getVersion(record.organisationId, record.kind, record.id, record.versionId), created: false };
    },
    async getVersion(organisationId, kind, id, versionId) {
      return json((await db.query(`SELECT data FROM ${t.versions} WHERE organisation_id = $1 AND kind = $2 AND id = $3 AND version_id = $4`, [organisationId, kind, id, versionId])).rows[0]);
    },
    async listVersions(filter) {
      return (await db.query(
        `SELECT data FROM ${t.versions} WHERE organisation_id = $1 AND kind = $2 AND id = $3 ORDER BY number LIMIT $4`,
        [filter.organisationId, filter.kind, filter.id, boundedLimit(filter.limit, 1000)])).rows.map(json);
    },

    async putFinding(record) {
      const inserted = await db.query(
        `INSERT INTO ${t.findings} (organisation_id, id, received_at, data) VALUES ($1, $2, $3::timestamptz, $4::jsonb)
         ON CONFLICT (organisation_id, id) DO NOTHING RETURNING data`,
        [record.organisationId, record.id, record.receivedAt, JSON.stringify(record)]);
      if (inserted.rows.length) return { record: json(inserted.rows[0]), created: true };
      return { record: json((await db.query(`SELECT data FROM ${t.findings} WHERE organisation_id = $1 AND id = $2`, [record.organisationId, record.id])).rows[0]), created: false };
    },
    async listFindings(filter = {}) {
      const params = [filter.organisationId]; let sql = `SELECT data FROM ${t.findings} WHERE organisation_id = $1`;
      if (filter.since != null) { params.push(filter.since); sql += ` AND received_at >= $${params.length}::timestamptz`; }
      if (filter.until != null) { params.push(filter.until); sql += ` AND received_at <= $${params.length}::timestamptz`; }
      params.push(boundedLimit(filter.limit));
      return (await db.query(`${sql} ORDER BY received_at DESC, id LIMIT $${params.length}`, params)).rows.map(json);
    }
  };
}

module.exports = { postgresGovernorSchema, createPostgresGovernorStore };
