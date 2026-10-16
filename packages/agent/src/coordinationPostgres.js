'use strict';
// PostgreSQL implementations for the scheduler (lock, run state) and the approval queue (actions).
// Schema creation is explicit and idempotent; every value goes through SQL parameters.
function identifier(name, fallback) {
  const value = name ?? fallback;
  if (typeof value !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,47}$/.test(value)) throw new Error('table must be a plain SQL identifier of at most 48 characters.');
  return value;
}
const json = (value) => typeof value === 'string' ? JSON.parse(value) : value;

/**
 * Lock on `pg_try_advisory_lock`. It belongs to a database session, so `pool` must offer `connect()` (a pg Pool):
 * one client is held per lock until `release()`, and a crashed process frees its locks when its connection drops.
 */
function createPostgresLock(pool, options = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('A pool with connect() is required (advisory locks belong to one session).');
  const prefix = options.prefix ?? 'astratra:agent:lock:';
  return {
    async acquire(key) {
      const client = await pool.connect();
      const name = `${prefix}${key}`;
      try {
        const { rows: [row] } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS ok', [name]);
        if (!row.ok) { client.release(); return null; }
      } catch (error) { client.release(); throw error; }
      let done = false;
      return {
        async release() {
          if (done) return; done = true;
          try { await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [name]); } finally { client.release(); }
        }
      };
    }
  };
}
function postgresScheduleSchema(options) {
  const table = identifier(options?.table, 'astratra_agent_schedule');
  return `CREATE TABLE IF NOT EXISTS "${table}" (id text PRIMARY KEY, data jsonb NOT NULL);`;
}
/** Run state of the scheduler tasks, shared by every process. */
function createPostgresScheduleStore(db, options) {
  if (!db || typeof db.query !== 'function') throw new Error('A database with query(sql, params) is required.');
  const table = identifier(options?.table, 'astratra_agent_schedule');
  return {
    async get(id) { const { rows } = await db.query(`SELECT data FROM "${table}" WHERE id = $1`, [id]); return rows[0] ? json(rows[0].data) : null; },
    async set(id, state) { await db.query(`INSERT INTO "${table}" (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, JSON.stringify(state)]); }
  };
}
function postgresApprovalSchema(options) {
  const table = identifier(options?.table, 'astratra_agent_approvals');
  return `CREATE TABLE IF NOT EXISTS "${table}" (
  id text PRIMARY KEY,
  type text NOT NULL,
  input jsonb NOT NULL,
  requested_by text NOT NULL,
  meta jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  decided_by text,
  decided_at timestamptz,
  executed_at timestamptz,
  result jsonb,
  reason text,
  refusal jsonb
);
CREATE INDEX IF NOT EXISTS "${table}_status_idx" ON "${table}" (status, created_at DESC);`;
}
const ms = (column) => `(extract(epoch from ${column}) * 1000)::float8`;
const COLUMNS = `id, type, input, requested_by, meta, status, ${ms('created_at')} AS created_ms, ${ms('expires_at')} AS expires_ms, decided_by, ${ms('decided_at')} AS decided_ms, ${ms('executed_at')} AS executed_ms, result, reason, refusal`;
const time = (value) => value == null ? null : Math.round(Number(value));
const toAction = (row) => row ? ({ id: row.id, type: row.type, input: json(row.input), requestedBy: row.requested_by, meta: json(row.meta) ?? null, status: row.status, createdAt: time(row.created_ms), expiresAt: time(row.expires_ms), decidedBy: row.decided_by, decidedAt: time(row.decided_ms), executedAt: time(row.executed_ms), result: json(row.result) ?? null, reason: row.reason, refusal: json(row.refusal) ?? null }) : null;
/** Approval store. Every transition is one conditional UPDATE, so two concurrent approvals cannot both win. */
function createPostgresApprovalStore(db, options) {
  if (!db || typeof db.query !== 'function') throw new Error('A database with query(sql, params) is required.');
  const t = `"${identifier(options?.table, 'astratra_agent_approvals')}"`;
  const one = async (sql, params) => toAction((await db.query(sql, params)).rows[0]);
  return {
    create: (a) => one(`INSERT INTO ${t} (id, type, input, requested_by, meta, status, created_at, expires_at) VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, 'pending', to_timestamp($6::float8 / 1000), CASE WHEN $7::float8 IS NULL THEN NULL ELSE to_timestamp($7::float8 / 1000) END) RETURNING ${COLUMNS}`, [a.id, a.type, JSON.stringify(a.input), a.requestedBy, a.meta == null ? null : JSON.stringify(a.meta), a.createdAt, a.expiresAt]),
    get: (id) => one(`SELECT ${COLUMNS} FROM ${t} WHERE id = $1`, [id]),
    async list({ status, type, requestedBy, limit = 50, before } = {}) {
      const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${t} WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR type = $2) AND ($3::text IS NULL OR requested_by = $3) AND ($4::float8 IS NULL OR created_at < to_timestamp($4::float8 / 1000)) ORDER BY created_at DESC, id LIMIT $5`, [status ?? null, type ?? null, requestedBy ?? null, before ?? null, limit]);
      return rows.map(toAction);
    },
    reserve: (id, by, at) => one(`UPDATE ${t} SET status = 'approved', decided_by = $2, decided_at = to_timestamp($3::float8 / 1000), executed_at = NULL WHERE id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > to_timestamp($3::float8 / 1000)) RETURNING ${COLUMNS}`, [id, by, at]),
    finish: (id, result, at) => one(`UPDATE ${t} SET result = $2::jsonb, executed_at = to_timestamp($3::float8 / 1000) WHERE id = $1 AND status = 'approved' AND executed_at IS NULL RETURNING ${COLUMNS}`, [id, JSON.stringify(result ?? null), at]),
    revert: (id, by, refusal) => one(`UPDATE ${t} SET status = 'pending', decided_by = NULL, decided_at = NULL, refusal = $3::jsonb WHERE id = $1 AND status = 'approved' AND decided_by = $2 AND executed_at IS NULL RETURNING ${COLUMNS}`, [id, by, JSON.stringify(refusal)]),
    reject: (id, by, reason, at) => one(`UPDATE ${t} SET status = 'rejected', decided_by = $2, decided_at = to_timestamp($4::float8 / 1000), reason = $3 WHERE id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > to_timestamp($4::float8 / 1000)) RETURNING ${COLUMNS}`, [id, by, reason, at]),
    async expire(at) {
      const { rows } = await db.query(`UPDATE ${t} SET status = 'expired', decided_at = to_timestamp($1::float8 / 1000) WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= to_timestamp($1::float8 / 1000) RETURNING ${COLUMNS}`, [at]);
      return rows.map(toAction);
    }
  };
}
module.exports = { createPostgresLock, postgresScheduleSchema, createPostgresScheduleStore, postgresApprovalSchema, createPostgresApprovalStore };
