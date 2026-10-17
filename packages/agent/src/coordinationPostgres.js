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
  refusal jsonb,
  decision_input jsonb
);
ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS decision_input jsonb;
CREATE INDEX IF NOT EXISTS "${table}_status_idx" ON "${table}" (status, created_at DESC);`;
}

/*
 * The approval store maps the queue's fields to columns. By default it uses the table made by postgresApprovalSchema;
 * `columns`, `statuses` and `scope` let it sit on a table you already have (one that is also your journal of actions,
 * with its own column names and status words). Fields marked optional may be mapped to null: they are then not kept.
 */
const time = (value) => value == null ? null : Math.round(Number(value));
const DEFAULT_COLUMNS = Object.freeze({
  id: 'id', type: 'type', input: 'input', requestedBy: 'requested_by', meta: 'meta', status: 'status',
  createdAt: 'created_at', expiresAt: 'expires_at', decidedBy: 'decided_by', decidedAt: 'decided_at',
  executedAt: 'executed_at', result: 'result', reason: 'reason', refusal: 'refusal', decisionInput: 'decision_input'
});
const OPTIONAL_COLUMNS = Object.freeze(['meta', 'expiresAt', 'result', 'reason', 'refusal', 'decisionInput']);
const JSON_FIELDS = new Set(['input', 'meta', 'result', 'refusal', 'decisionInput']);
const TIME_FIELDS = new Set(['createdAt', 'expiresAt', 'decidedAt', 'executedAt']);
const STATUS_WORDS = Object.freeze(['pending', 'approved', 'rejected', 'expired']);

function approvalMapping(options = {}) {
  const extra = Object.keys(options.columns ?? {}).filter((field) => !(field in DEFAULT_COLUMNS));
  if (extra.length) throw new Error(`columns: unknown field(s) ${extra.join(', ')}.`);
  const columns = {};
  for (const [field, fallback] of Object.entries(DEFAULT_COLUMNS)) {
    const given = options.columns?.[field];
    if (given === null) { if (!OPTIONAL_COLUMNS.includes(field)) throw new Error(`columns.${field} cannot be null.`); columns[field] = null; continue; }
    columns[field] = given === undefined ? fallback : identifier(given);
  }
  const statuses = {};
  for (const word of STATUS_WORDS) {
    const value = options.statuses?.[word] ?? word;
    if (typeof value !== 'string' || !value) throw new Error(`statuses.${word} must be a non-empty string.`);
    statuses[word] = value;
  }
  if (new Set(Object.values(statuses)).size !== STATUS_WORDS.length) throw new Error('statuses must give a different word to each status.');
  if (Object.keys(options.statuses ?? {}).some((word) => !STATUS_WORDS.includes(word))) throw new Error(`statuses: only ${STATUS_WORDS.join(', ')}.`);
  let scope = null;
  if (options.scope != null) {
    if (typeof options.scope !== 'object' || options.scope.value === undefined) throw new Error('scope must be { column, value }.');
    scope = { column: identifier(options.scope.column), value: options.scope.value };
  }
  return { columns, statuses, scope };
}

/** Approval store. Every transition is one conditional UPDATE, so two concurrent approvals cannot both win. */
function createPostgresApprovalStore(db, options) {
  if (!db || typeof db.query !== 'function') throw new Error('A database with query(sql, params) is required.');
  const t = `"${identifier(options?.table, 'astratra_agent_approvals')}"`;
  const { columns, statuses, scope } = approvalMapping(options);
  const c = (field) => `"${columns[field]}"`;
  const has = (field) => columns[field] !== null;
  const fromStatus = Object.fromEntries(Object.entries(statuses).map(([word, value]) => [value, word]));
  const select = Object.keys(DEFAULT_COLUMNS).filter(has)
    .map((field) => TIME_FIELDS.has(field) ? `(extract(epoch from ${c(field)}) * 1000)::float8 AS "f_${field}"` : `${c(field)} AS "f_${field}"`).join(', ');
  const toAction = (row) => {
    if (!row) return null;
    const action = {};
    for (const field of Object.keys(DEFAULT_COLUMNS)) {
      if (!has(field)) { action[field] = field === 'decisionInput' ? undefined : null; continue; }
      const value = row[`f_${field}`];
      action[field] = TIME_FIELDS.has(field) ? time(value) : JSON_FIELDS.has(field) ? (json(value) ?? null) : (value ?? null);
    }
    // A status word that is not one of the four (a row of your journal that never needed approval) is given as is.
    action.status = fromStatus[action.status] ?? action.status;
    return action;
  };
  /* Parameters $1.. are the call's own; the scope value and the status words come after them. */
  const build = (base) => {
    const params = [...base];
    const add = (value) => { params.push(value); return `$${params.length}`; };
    const status = (word) => `${add(statuses[word])}::text`;
    // Added only where a query uses it: an unused parameter would have no type and PostgreSQL would refuse it.
    const inScope = () => scope ? ` AND "${scope.column}" = ${add(scope.value)}` : '';
    return { params, add, status, inScope };
  };
  const ts = (p) => `to_timestamp(${p}::float8 / 1000)`;
  const run = async (sql, params) => (await db.query(sql, params)).rows.map(toAction);
  const one = async (sql, params) => (await run(sql, params))[0] ?? null;
  const notExpired = (_q, at) => has('expiresAt') ? ` AND (${c('expiresAt')} IS NULL OR ${c('expiresAt')} > ${ts(at)})` : '';
  return {
    async create(a) {
      const q = build([]);
      const fields = ['id', 'type', 'input', 'requestedBy', 'meta', 'status', 'createdAt', 'expiresAt'].filter(has);
      const values = fields.map((field) => {
        if (field === 'status') return q.status('pending');
        if (JSON_FIELDS.has(field)) return `${q.add(a[field] == null ? null : JSON.stringify(a[field]))}::jsonb`;
        if (TIME_FIELDS.has(field)) { const p = q.add(a[field] ?? null); return `CASE WHEN ${p}::float8 IS NULL THEN NULL ELSE ${ts(p)} END`; }
        return q.add(a[field]);
      });
      const names = fields.map(c);
      if (scope) { names.push(`"${scope.column}"`); values.push(q.add(scope.value)); }
      return one(`INSERT INTO ${t} (${names.join(', ')}) VALUES (${values.join(', ')}) RETURNING ${select}`, q.params);
    },
    async get(id) {
      const q = build([id]);
      return one(`SELECT ${select} FROM ${t} WHERE ${c('id')} = $1${q.inScope()}`, q.params);
    },
    async list({ status, type, requestedBy, limit = 50, before } = {}) {
      const q = build([type ?? null, requestedBy ?? null, before ?? null, limit]);
      const byStatus = status ? ` AND ${c('status')} = ${q.add(statuses[status] ?? status)}::text` : '';
      return run(`SELECT ${select} FROM ${t} WHERE ($1::text IS NULL OR ${c('type')} = $1) AND ($2::text IS NULL OR ${c('requestedBy')} = $2) AND ($3::float8 IS NULL OR ${c('createdAt')} < ${ts('$3')})${byStatus}${q.inScope()} ORDER BY ${c('createdAt')} DESC, ${c('id')} LIMIT $4`, q.params);
    },
    async reserve(id, by, at, decisionInput = null) {
      const q = build([id, by, at]);
      const keep = has('decisionInput') ? `, ${c('decisionInput')} = ${q.add(decisionInput == null ? null : JSON.stringify(decisionInput))}::jsonb` : '';
      return one(`UPDATE ${t} SET ${c('status')} = ${q.status('approved')}, ${c('decidedBy')} = $2, ${c('decidedAt')} = ${ts('$3')}, ${c('executedAt')} = NULL${keep} WHERE ${c('id')} = $1 AND ${c('status')} = ${q.status('pending')}${notExpired(q, '$3')}${q.inScope()} RETURNING ${select}`, q.params);
    },
    async finish(id, result, at) {
      const q = build([id, at]);
      const keep = has('result') ? `, ${c('result')} = ${q.add(JSON.stringify(result ?? null))}::jsonb` : '';
      return one(`UPDATE ${t} SET ${c('executedAt')} = ${ts('$2')}${keep} WHERE ${c('id')} = $1 AND ${c('status')} = ${q.status('approved')} AND ${c('executedAt')} IS NULL${q.inScope()} RETURNING ${select}`, q.params);
    },
    async revert(id, by, refusal) {
      const q = build([id, by]);
      const keep = (has('refusal') ? `, ${c('refusal')} = ${q.add(JSON.stringify(refusal))}::jsonb` : '') + (has('decisionInput') ? `, ${c('decisionInput')} = NULL` : '');
      return one(`UPDATE ${t} SET ${c('status')} = ${q.status('pending')}, ${c('decidedBy')} = NULL, ${c('decidedAt')} = NULL${keep} WHERE ${c('id')} = $1 AND ${c('status')} = ${q.status('approved')} AND ${c('decidedBy')} = $2 AND ${c('executedAt')} IS NULL${q.inScope()} RETURNING ${select}`, q.params);
    },
    async reject(id, by, reason, at) {
      const q = build([id, by, at]);
      const keep = has('reason') ? `, ${c('reason')} = ${q.add(reason)}` : '';
      return one(`UPDATE ${t} SET ${c('status')} = ${q.status('rejected')}, ${c('decidedBy')} = $2, ${c('decidedAt')} = ${ts('$3')}${keep} WHERE ${c('id')} = $1 AND ${c('status')} = ${q.status('pending')}${notExpired(q, '$3')}${q.inScope()} RETURNING ${select}`, q.params);
    },
    async expire(at) {
      if (!has('expiresAt')) return [];
      const q = build([at]);
      return run(`UPDATE ${t} SET ${c('status')} = ${q.status('expired')}, ${c('decidedAt')} = ${ts('$1')} WHERE ${c('status')} = ${q.status('pending')} AND ${c('expiresAt')} IS NOT NULL AND ${c('expiresAt')} <= ${ts('$1')}${q.inScope()} RETURNING ${select}`, q.params);
    }
  };
}
module.exports = { createPostgresLock, postgresScheduleSchema, createPostgresScheduleStore, postgresApprovalSchema, createPostgresApprovalStore };
