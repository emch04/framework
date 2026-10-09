'use strict';
const { GROUPS } = require('./stores');

function tableOf(options = {}) {
  const name = options.table ?? 'astratra_agent_feedback';
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,47}$/.test(name)) throw new Error('table must be a plain SQL identifier of at most 48 characters.');
  return name;
}
function postgresFeedbackSchema(options) {
  const name = tableOf(options);
  return `CREATE TABLE IF NOT EXISTS "${name}" (
  id text PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT '',
  user_id text NOT NULL,
  run_id text NOT NULL,
  message_id text,
  rating text NOT NULL CHECK (rating IN ('up', 'down')),
  reason text,
  comment text,
  agent text,
  mode text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, user_id, run_id)
);
CREATE INDEX IF NOT EXISTS "${name}_user_idx" ON "${name}" (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS "${name}_updated_idx" ON "${name}" (updated_at DESC);`;
}
const COLUMNS = `id, tenant_id, user_id, run_id, message_id, rating, reason, comment, agent, mode,
  (extract(epoch from created_at) * 1000)::float8 AS created_ms, (extract(epoch from updated_at) * 1000)::float8 AS updated_ms`;
const read = (row) => row ? ({ id: row.id, tenantId: row.tenant_id || null, userId: row.user_id, runId: row.run_id, messageId: row.message_id, rating: row.rating, reason: row.reason, comment: row.comment, agent: row.agent, mode: row.mode, createdAt: Math.round(Number(row.created_ms)), updatedAt: Math.round(Number(row.updated_ms)) }) : null;

function where(filter, params) {
  const parts = [];
  const add = (sql, value) => { params.push(value); parts.push(sql.replace('?', `$${params.length}`)); };
  if (filter.tenantId !== undefined) add('tenant_id = ?', filter.tenantId ?? '');
  for (const [field, column] of [['userId', 'user_id'], ['runId', 'run_id'], ['rating', 'rating'], ['reason', 'reason'], ['agent', 'agent'], ['mode', 'mode']]) if (filter[field] != null) add(`${column} = ?`, filter[field]);
  if (filter.since != null) add('updated_at >= to_timestamp(?::double precision / 1000)', filter.since);
  if (filter.until != null) add('updated_at < to_timestamp(?::double precision / 1000)', filter.until);
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

/** PostgreSQL store; `db` is any `{ query(sql, params) }`. Every value is a SQL parameter. */
function createPostgresFeedbackStore(db, options) {
  if (!db || typeof db.query !== 'function') throw new Error('A database with query(sql, params) is required.');
  const table = `"${tableOf(options)}"`;
  return {
    async put(r) {
      const result = await db.query(
        `INSERT INTO ${table} (id, tenant_id, user_id, run_id, message_id, rating, reason, comment, agent, mode, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11::double precision / 1000), to_timestamp($12::double precision / 1000))
         ON CONFLICT (tenant_id, user_id, run_id) DO UPDATE SET message_id = EXCLUDED.message_id, rating = EXCLUDED.rating, reason = EXCLUDED.reason,
           comment = EXCLUDED.comment, agent = EXCLUDED.agent, mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at
         RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
        [r.id, r.tenantId ?? '', r.userId, r.runId, r.messageId, r.rating, r.reason, r.comment, r.agent, r.mode, r.createdAt, r.updatedAt]);
      return { record: read(result.rows[0]), created: Boolean(result.rows[0].inserted) };
    },
    async get(key) {
      return read((await db.query(`SELECT ${COLUMNS} FROM ${table} WHERE tenant_id = $1 AND user_id = $2 AND run_id = $3`, [key.tenantId ?? '', key.userId, key.runId])).rows[0]);
    },
    async remove(key) {
      return (await db.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND user_id = $2 AND run_id = $3 RETURNING id`, [key.tenantId ?? '', key.userId, key.runId])).rows.length > 0;
    },
    async list(filter = {}) {
      const params = [];
      const clause = where(filter, params);
      params.push(Math.min(Math.max(Number(filter.limit) || 100, 1), 1000));
      return (await db.query(`SELECT ${COLUMNS} FROM ${table}${clause} ORDER BY updated_at DESC, id ASC LIMIT $${params.length}`, params)).rows.map(read);
    },
    async aggregate(filter = {}) {
      if (filter.groupBy != null && !GROUPS.includes(filter.groupBy)) throw new Error('Unknown groupBy.');
      const expression = { agent: 'agent', mode: 'mode', reason: 'reason', day: `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')` }[filter.groupBy] || 'NULL::text';
      const params = [];
      let clause = where(filter, params);
      if (filter.groupBy === 'reason') clause += `${clause ? ' AND' : ' WHERE'} rating = 'down'`;
      const rows = (await db.query(`SELECT ${expression} AS key, count(*) FILTER (WHERE rating = 'up') AS up, count(*) FILTER (WHERE rating = 'down') AS down FROM ${table}${clause} GROUP BY 1 ORDER BY 1`, params)).rows;
      return rows.map((row) => ({ key: row.key, up: Number(row.up), down: Number(row.down) }));
    }
  };
}
module.exports = { postgresFeedbackSchema, createPostgresFeedbackStore };
