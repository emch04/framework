const { randomUUID } = require('crypto');

const DEFAULT_USERS_TABLE = 'astratra_users';
const DEFAULT_SETTINGS_TABLE = 'astratra_settings';

function loadPg() {
  try {
    return require('pg');
  } catch (_error) {
    throw new Error('@astratra/store-postgres requires pg. Install pg or pass it from an app that already depends on it.');
  }
}

function isValidIdentifier(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function assertValidIdentifier(name, label) {
  if (!isValidIdentifier(name)) {
    throw new Error(`@astratra/store-postgres: invalid ${label} "${name}".`);
  }
}

function createConnectionContext(options = {}) {
  if (options.pool) {
    return { pool: options.pool, managed: false };
  }

  if (!options.connectionString) {
    throw new Error('createPostgres store requires options.pool or options.connectionString.');
  }

  const { Pool } = loadPg();
  return { pool: new Pool({ connectionString: options.connectionString }), managed: true };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isInvalidTextRepresentation(error) {
  return error && error.code === '22P02';
}

function mergeUserRow(row) {
  if (!row) return null;
  return { ...row.data, id: row.id };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createPostgresUsersStore(options = {}) {
  const table = options.usersTable || DEFAULT_USERS_TABLE;
  assertValidIdentifier(table, 'usersTable');
  const uniqueEmail = options.uniqueEmail !== false;
  const context = createConnectionContext(options);
  const { pool } = context;

  const ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id UUID PRIMARY KEY,
        email TEXT,
        role TEXT,
        data JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    if (uniqueEmail) {
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_email_unique_idx ON ${table} (email)`);
    }
  })();

  return {
    async findByEmail(email) {
      await ready;
      const result = await pool.query(`SELECT id, data FROM ${table} WHERE email = $1 LIMIT 1`, [normalizeEmail(email)]);
      return mergeUserRow(result.rows[0]);
    },

    async findById(id) {
      await ready;
      if (!isValidUuid(id)) return null;
      try {
        const result = await pool.query(`SELECT id, data FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
        return mergeUserRow(result.rows[0]);
      } catch (error) {
        if (isInvalidTextRepresentation(error)) return null;
        throw error;
      }
    },

    async create(userData) {
      await ready;
      const data = { ...(userData || {}) };
      delete data.id;
      if (data.email !== undefined) {
        data.email = normalizeEmail(data.email);
      }
      const id = randomUUID();
      const email = data.email ?? null;
      const role = data.role ?? null;

      const result = await pool.query(
        `INSERT INTO ${table} (id, email, role, data) VALUES ($1, $2, $3, $4) RETURNING id, data`,
        [id, email, role, JSON.stringify(data)]
      );
      return mergeUserRow(result.rows[0]);
    },

    async list({ role, limit = 50, offset = 0 } = {}) {
      await ready;
      const safeLimit = Math.max(Number(limit) || 50, 0);
      const safeOffset = Math.max(Number(offset) || 0, 0);

      const result = role
        ? await pool.query(
            `SELECT id, data FROM ${table} WHERE role = $1 ORDER BY id LIMIT $2 OFFSET $3`,
            [role, safeLimit, safeOffset]
          )
        : await pool.query(
            `SELECT id, data FROM ${table} ORDER BY id LIMIT $1 OFFSET $2`,
            [safeLimit, safeOffset]
          );

      return result.rows.map(mergeUserRow);
    },

    async count({ role } = {}) {
      await ready;
      const result = role
        ? await pool.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE role = $1`, [role])
        : await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      return result.rows[0].count;
    },

    async countByRole() {
      await ready;
      const result = await pool.query(`
        SELECT COALESCE(role, 'unknown') AS role, COUNT(*)::int AS count
        FROM ${table}
        GROUP BY COALESCE(role, 'unknown')
        ORDER BY role
      `);
      return Object.fromEntries(result.rows.map((row) => [row.role, row.count]));
    },

    async update(id, patch) {
      await ready;
      if (!isValidUuid(id)) return null;
      const safePatch = { ...(patch || {}) };
      delete safePatch.id;
      if (safePatch.email !== undefined) {
        safePatch.email = normalizeEmail(safePatch.email);
      }

      try {
        const existing = await pool.query(`SELECT id, data FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
        if (existing.rows.length === 0) return null;

        const mergedData = { ...existing.rows[0].data, ...safePatch };
        const email = mergedData.email ?? null;
        const role = mergedData.role ?? null;

        const result = await pool.query(
          `UPDATE ${table} SET email = $1, role = $2, data = $3 WHERE id = $4 RETURNING id, data`,
          [email, role, JSON.stringify(mergedData), id]
        );
        return mergeUserRow(result.rows[0]);
      } catch (error) {
        if (isInvalidTextRepresentation(error)) return null;
        throw error;
      }
    },

    async disconnect() {
      if (context.managed) {
        await pool.end();
      }
    }
  };
}

function createPostgresSettingsStore(options = {}) {
  const table = options.settingsTable || DEFAULT_SETTINGS_TABLE;
  assertValidIdentifier(table, 'settingsTable');
  const context = createConnectionContext(options);
  const { pool } = context;

  const ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        key TEXT PRIMARY KEY,
        value JSONB
      )
    `);
  })();

  return {
    async get(key) {
      await ready;
      const result = await pool.query(`SELECT value FROM ${table} WHERE key = $1 LIMIT 1`, [key]);
      return result.rows.length > 0 ? result.rows[0].value : null;
    },

    async set(key, value) {
      await ready;
      const result = await pool.query(
        `INSERT INTO ${table} (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
         RETURNING value`,
        [key, JSON.stringify(value)]
      );
      return result.rows[0].value;
    },

    async getAll() {
      await ready;
      const result = await pool.query(`SELECT key, value FROM ${table}`);
      return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
    },

    async disconnect() {
      if (context.managed) {
        await pool.end();
      }
    }
  };
}

module.exports = {
  createPostgresSettingsStore,
  createPostgresUsersStore
};
