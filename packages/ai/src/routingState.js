'use strict';

// update() is an atomic read/modify/write boundary. Database adapters must
// serialize it across processes (Redis CAS, PostgreSQL row/advisory locks).
function createMemoryRoutingStore() {
  const states = new Map();
  const pending = new Map();
  const clone = (value) => value == null ? null : globalThis.structuredClone(value);
  async function update(key, change) {
    const previous = pending.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => {
      const { state, value } = change(clone(states.get(key)));
      if (state == null) states.delete(key);
      else states.set(key, clone(state));
      return value;
    });
    pending.set(key, current);
    try { return await current; }
    finally { if (pending.get(key) === current) pending.delete(key); }
  }
  return {
    update,
    async read(key) { await pending.get(key); return clone(states.get(key)); }
  };
}

const CAS = `
local old = redis.call('GET', KEYS[1])
if (old or '') ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1])
else redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) end
return 1`;

// The client is owned by the consumer. No connection or silent RAM fallback.
function createRedisRoutingStore({ client, prefix = 'astratra:ai:', ttlMs = 172800000, maxRetries = 100 } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs < 86400000 || !Number.isInteger(maxRetries) || maxRetries < 1) throw new TypeError('INVALID_REDIS_STATE_OPTIONS');
  if (!client || typeof client.eval !== 'function' || typeof client.get !== 'function') throw new TypeError('REDIS_CLIENT_REQUIRED');
  return {
    async read(key) {
      const raw = await client.get(prefix + key);
      return raw == null ? null : JSON.parse(raw);
    },
    async update(key, change) {
      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const raw = await client.get(prefix + key);
        const { state, value } = change(raw == null ? null : JSON.parse(raw));
        const stored = await client.eval(CAS, {
          keys: [prefix + key], arguments: [raw || '', state == null ? '' : JSON.stringify(state), String(ttlMs)]
        });
        if (Number(stored) === 1) return value;
      }
      throw new Error('AI_STATE_CONTENTION');
    }
  };
}

function createPostgresRoutingStore({ pool, table = 'ai_routing_state' } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new TypeError('INVALID_STATE_TABLE');
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  return {
    // Explicit: construction does not mutate a consumer's database.
    async initialize() { await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (key text PRIMARY KEY, state jsonb NOT NULL)`); },
    async read(key) {
      const { rows } = await pool.query(`SELECT state FROM ${table} WHERE key = $1`, [key]);
      return rows[0]?.state ?? null;
    },
    async update(key, change) {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        // Lock also protects first insertion; SELECT FOR UPDATE alone does not.
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${table}:${key}`]);
        const { rows } = await connection.query(`SELECT state FROM ${table} WHERE key = $1`, [key]);
        const { state, value } = change(rows[0]?.state ?? null);
        if (state == null) await connection.query(`DELETE FROM ${table} WHERE key = $1`, [key]);
        else await connection.query(`INSERT INTO ${table} (key, state) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state`, [key, JSON.stringify(state)]);
        await connection.query('COMMIT');
        return value;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally { connection.release(); }
    }
  };
}

module.exports = { createMemoryRoutingStore, createRedisRoutingStore, createPostgresRoutingStore };
