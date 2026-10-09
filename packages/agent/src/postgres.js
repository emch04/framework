'use strict';
const { validateTask } = require('./taskStore');
function tableOf(options = {}) {
  const name = options.table ?? 'astratra_agent_tasks';
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('table must be a plain SQL identifier.');
  return `"${name}"`;
}
function postgresTaskSchema(options) {
  const table = tableOf(options);
  return `CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, data jsonb NOT NULL, lock_owner text, lock_until timestamptz);`;
}
function createPostgresTaskStore(db, options) {
  if (!db || typeof db.query !== 'function') throw new Error('A database with query(sql, params) is required.');
  const table = tableOf(options);
  const read = (row) => row ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : null;
  return {
    async create(task) { const data = validateTask(task); return read((await db.query(`INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb) RETURNING data`, [data.id, JSON.stringify(data)])).rows[0]); },
    async get(id) { return read((await db.query(`SELECT data FROM ${table} WHERE id = $1`, [id])).rows[0]); },
    async acquire(id, owner, leaseMs) { return (await db.query(`UPDATE ${table} SET lock_owner = $2, lock_until = clock_timestamp() + $3 * interval '1 millisecond' WHERE id = $1 AND (lock_until IS NULL OR lock_until <= clock_timestamp()) RETURNING id`, [id, owner, leaseMs])).rows.length > 0; },
    async renew(id, owner, leaseMs) { return (await db.query(`UPDATE ${table} SET lock_until = clock_timestamp() + $3 * interval '1 millisecond' WHERE id = $1 AND lock_owner = $2 AND lock_until > clock_timestamp() RETURNING id`, [id, owner, leaseMs])).rows.length > 0; },
    async save(task, owner) { const data = validateTask(task); const row = (await db.query(`UPDATE ${table} SET data = $3::jsonb WHERE id = $1 AND lock_owner = $2 AND lock_until > clock_timestamp() RETURNING data`, [data.id, owner, JSON.stringify(data)])).rows[0]; if (!row) throw new Error('Task lock lost.'); return read(row); },
    async release(id, owner) { await db.query(`UPDATE ${table} SET lock_owner = NULL, lock_until = NULL WHERE id = $1 AND lock_owner = $2`, [id, owner]); }
  };
}
module.exports = { postgresTaskSchema, createPostgresTaskStore };
