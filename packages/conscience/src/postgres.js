'use strict';
const { prefixOf, requireQueryable } = require('./governor/util');
const { MAX_LIMIT } = require('./memoryStore');

const DEFAULT_PREFIX = 'astratra_conscience';
const limitOf = (value) => Math.min(Math.max(Number(value) || 1000, 1), MAX_LIMIT);

/** SQL that creates the conscience table. Idempotent: run it at every start or in a migration. */
function postgresConscienceSchema(options) {
  const p = prefixOf(options, DEFAULT_PREFIX);
  const table = `"${p}_records"`;
  return `CREATE TABLE IF NOT EXISTS ${table} (
  organisation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('decision', 'prediction', 'outcome', 'correction', 'lesson', 'self_model')),
  id text NOT NULL,
  user_id text,
  agent_id text,
  decision_id text,
  lesson_id text,
  event_at timestamptz,
  recorded_at timestamptz NOT NULL,
  fingerprint text NOT NULL,
  evidence_refs text[] NOT NULL DEFAULT '{}',
  envelope jsonb NOT NULL,
  seq bigserial,
  PRIMARY KEY (organisation_id, kind, id)
);
CREATE INDEX IF NOT EXISTS "${p}_recorded_idx" ON ${table} (organisation_id, kind, recorded_at, seq);
CREATE INDEX IF NOT EXISTS "${p}_user_idx" ON ${table} (organisation_id, user_id);
CREATE INDEX IF NOT EXISTS "${p}_decision_idx" ON ${table} (organisation_id, kind, decision_id);
CREATE INDEX IF NOT EXISTS "${p}_lesson_idx" ON ${table} (organisation_id, kind, lesson_id);
CREATE INDEX IF NOT EXISTS "${p}_event_idx" ON ${table} (organisation_id, kind, event_at);
CREATE INDEX IF NOT EXISTS "${p}_evidence_idx" ON ${table} USING gin (evidence_refs);`;
}

const read = (row) => (row ? (typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope) : null);

/**
 * Conscience store on PostgreSQL. `db` is any `{ query(sql, params) }` (a
 * `pg` Pool or client). Every value is a SQL parameter; identifiers come from
 * a checked prefix only.
 */
function createPostgresConscienceStore(db, options) {
  requireQueryable(db);
  const table = `"${prefixOf(options, DEFAULT_PREFIX)}_records"`;
  const columns = (e) => [e.organisationId, e.kind, e.id, e.userId, e.agentId, e.decisionId, e.lessonId, e.eventAt, e.recordedAt, e.fingerprint, e.evidenceRefs || [], JSON.stringify(e)];

  return {
    async put(envelope) {
      const inserted = await db.query(
        `INSERT INTO ${table} (organisation_id, kind, id, user_id, agent_id, decision_id, lesson_id, event_at, recorded_at, fingerprint, evidence_refs, envelope)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11::text[], $12::jsonb)
         ON CONFLICT (organisation_id, kind, id) DO NOTHING RETURNING envelope`, columns(envelope));
      if (inserted.rows.length) return { record: read(inserted.rows[0]), created: true };
      return { record: await this.get(envelope.kind, envelope.organisationId, envelope.id), created: false };
    },
    async get(kind, organisationId, id) {
      return read((await db.query(`SELECT envelope FROM ${table} WHERE organisation_id = $1 AND kind = $2 AND id = $3`, [organisationId, kind, id])).rows[0]);
    },
    async list(kind, filter = {}) {
      const params = [filter.organisationId, kind];
      const parts = ['organisation_id = $1', 'kind = $2'];
      const add = (sql, value) => { params.push(value); parts.push(sql.replace('?', `$${params.length}`)); };
      for (const [field, column] of [['userId', 'user_id'], ['agentId', 'agent_id'], ['decisionId', 'decision_id'], ['lessonId', 'lesson_id']]) {
        if (filter[field] === undefined) continue;
        if (filter[field] === null) parts.push(`${column} IS NULL`); else add(`${column} = ?`, filter[field]);
      }
      if (Array.isArray(filter.decisionIds)) add('decision_id = ANY(?::text[])', filter.decisionIds);
      if (filter.evidenceRef != null) add('evidence_refs @> ARRAY[?::text]', filter.evidenceRef);
      if (filter.eventFrom != null) add('event_at >= ?::timestamptz', filter.eventFrom);
      if (filter.eventTo != null) add('event_at < ?::timestamptz', filter.eventTo);
      if (filter.recordedTo != null) add('recorded_at <= ?::timestamptz', filter.recordedTo);
      params.push(limitOf(filter.limit));
      const order = filter.order === 'desc' ? 'DESC' : 'ASC';
      const sql = `SELECT envelope FROM ${table} WHERE ${parts.join(' AND ')} ORDER BY recorded_at ${order}, seq ${order} LIMIT $${params.length}`;
      return (await db.query(sql, params)).rows.map(read);
    },
    async replace(envelope) {
      const result = await db.query(
        `UPDATE ${table} SET user_id = $4, agent_id = $5, decision_id = $6, lesson_id = $7, event_at = $8::timestamptz, recorded_at = $9::timestamptz,
           fingerprint = $10, evidence_refs = $11::text[], envelope = $12::jsonb
         WHERE organisation_id = $1 AND kind = $2 AND id = $3 RETURNING envelope`, columns(envelope));
      return read(result.rows[0]);
    },
    async remove(kind, organisationId, ids) {
      if (!ids.length) return 0;
      const result = await db.query(`DELETE FROM ${table} WHERE organisation_id = $1 AND kind = $2 AND id = ANY($3::text[])`, [organisationId, kind, ids]);
      return result.rowCount ?? 0;
    }
  };
}

module.exports = { postgresConscienceSchema, createPostgresConscienceStore };
