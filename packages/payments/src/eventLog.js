/**
 * Remembering which events have already been acted on.
 *
 * Providers resend events, by design and on purpose: they cannot tell a lost
 * response from a slow one, so they err on the side of sending again. Without a
 * record, the second delivery re-confirms an order, re-sends a receipt, or
 * re-credits an account.
 *
 * And they resend CONCURRENTLY: a retry can land while the first delivery is
 * still running. "Have I seen it?" then "remember it" leaves a window where both
 * deliveries answer no. The event must be reserved atomically BEFORE it is
 * handled:
 *
 *   claim(eventId, meta)  -> boolean  true: reserved now, handle it.
 *                                     false: already handled or being handled.
 *   release(eventId)      -> void     the handler failed: free the claim so the
 *                                     provider's retry can work.
 *   record(eventId, meta) -> void     handled: the claim becomes permanent.
 *   seen(eventId)         -> boolean  handled (a claim in progress is not).
 *
 * In SQL, claim is one statement on a unique key:
 *   INSERT INTO webhook_events (id, status, claimed_at) VALUES ($1, 'pending', now())
 *   ON CONFLICT (id) DO UPDATE SET claimed_at = now()
 *     WHERE webhook_events.status = 'pending' AND webhook_events.claimed_at < now() - interval '15 minutes'
 *   RETURNING id;   -- a row back means claimed
 * A claim must expire: a process that crashes mid-handler never releases it.
 */

const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * In-process log for tests and local development. Not persistent, and NOT safe
 * across several instances: two processes each keep their own memory, so a
 * replay reaching the other one goes through. Use a shared store in production.
 */
function createMemoryEventLog(options = {}) {
  const limit = options.limit || 10_000;
  const claimTtlMs = options.claimTtlMs || DEFAULT_CLAIM_TTL_MS;
  const now = options.now || Date.now;
  const entries = new Map();

  function trim() {
    /* A log that only grows is a memory leak with a long fuse. Oldest out
       first — a replay older than the last ten thousand events is not a
       scenario worth holding memory for. */
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  return {
    /* Synchronous between the read and the write: within one process, no
       other delivery can slip in between. */
    async claim(eventId, meta = {}) {
      const key = String(eventId);
      const entry = entries.get(key);
      if (entry && (entry.handled || now() - entry.claimedAt < claimTtlMs)) return false;
      entries.delete(key);
      entries.set(key, { handled: false, claimedAt: now(), ...meta });
      trim();
      return true;
    },
    async release(eventId) {
      const key = String(eventId);
      const entry = entries.get(key);
      if (entry && !entry.handled) entries.delete(key);
    },
    async seen(eventId) {
      const entry = entries.get(String(eventId));
      return Boolean(entry && entry.handled);
    },
    async record(eventId, meta = {}) {
      const key = String(eventId);
      const previous = entries.get(key) || {};
      entries.set(key, { ...previous, ...meta, handled: true, at: new Date(now()) });
      trim();
    },
    size: () => entries.size
  };
}

/* ───────────── PostgreSQL: the log shared by every instance ───────────── */

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/i;

function quoteTable(table) {
  const parts = String(table).split('.');
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new TypeError(`Invalid table name: ${JSON.stringify(table)} (letters, digits and _ only, optionally schema.table).`);
  }
  return parts.map((part) => `"${part}"`).join('.');
}

/**
 * The table behind createPostgresEventLog. Run it once (migration or startup);
 * it is idempotent.
 */
function postgresEventLogSchema(options = {}) {
  const table = quoteTable(options.table || 'webhook_events');
  return `CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('pending', 'handled')),
  claimed_at timestamptz NOT NULL,
  handled_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
)`;
}

/**
 * Event log in PostgreSQL, shared by every instance of the service: a retry
 * reaching another process is still refused. Same contract as the memory log;
 * claim is a single INSERT … ON CONFLICT on the primary key, so two concurrent
 * deliveries cannot both win, and an unfinished claim expires after claimTtlMs.
 *
 * `pool` is anything with query(text, params) (a pg Pool or client): the
 * package does not depend on pg. Create the table with postgresEventLogSchema().
 */
function createPostgresEventLog(pool, options = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createPostgresEventLog needs a pool with query(text, params) (for example a pg Pool).');
  }
  const table = quoteTable(options.table || 'webhook_events');
  const claimTtlMs = options.claimTtlMs || DEFAULT_CLAIM_TTL_MS;
  const now = options.now || Date.now;
  const at = () => new Date(now());
  const json = (meta) => JSON.stringify(meta && typeof meta === 'object' ? meta : {});

  return {
    async claim(eventId, meta = {}) {
      const time = at();
      const { rows } = await pool.query(
        `INSERT INTO ${table} (id, status, claimed_at, meta) VALUES ($1, 'pending', $2, $3::jsonb)
         ON CONFLICT (id) DO UPDATE SET claimed_at = EXCLUDED.claimed_at, meta = EXCLUDED.meta
           WHERE ${table}.status = 'pending' AND ${table}.claimed_at <= $4
         RETURNING id`,
        [String(eventId), time, json(meta), new Date(time.getTime() - claimTtlMs)]
      );
      return rows.length === 1;
    },
    /* Only a pending claim is freed: a handled event stays handled. */
    async release(eventId) {
      await pool.query(`DELETE FROM ${table} WHERE id = $1 AND status = 'pending'`, [String(eventId)]);
    },
    async record(eventId, meta = {}) {
      const time = at();
      await pool.query(
        `INSERT INTO ${table} (id, status, claimed_at, handled_at, meta) VALUES ($1, 'handled', $2, $2, $3::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = 'handled', handled_at = EXCLUDED.handled_at,
           meta = ${table}.meta || EXCLUDED.meta`,
        [String(eventId), time, json(meta)]
      );
    },
    async seen(eventId) {
      const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND status = 'handled'`, [String(eventId)]);
      return rows.length === 1;
    },
    /** Deletes handled events older than `olderThanMs` (a provider does not resend months-old events). */
    async prune(olderThanMs) {
      if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) throw new TypeError('prune(olderThanMs) needs a positive duration in milliseconds.');
      const { rowCount } = await pool.query(
        `DELETE FROM ${table} WHERE status = 'handled' AND handled_at < $1`,
        [new Date(now() - olderThanMs)]
      );
      return rowCount ?? 0;
    }
  };
}

module.exports = { createMemoryEventLog, createPostgresEventLog, postgresEventLogSchema };
