const DEFAULT_MIGRATIONS_TABLE = 'astratra_migrations';

function isValidIdentifier(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function assertValidIdentifier(name, label) {
  if (!isValidIdentifier(name)) {
    throw new Error(`@astratra/store-postgres: invalid ${label} "${name}".`);
  }
}

function assertMigrationsShape(migrations) {
  if (!Array.isArray(migrations)) {
    throw new Error('createPostgresMigrationRunner.run requires an array of migrations.');
  }
  const seen = new Set();
  for (const migration of migrations) {
    if (!migration || typeof migration.id !== 'string' || !migration.id) {
      throw new Error('Every migration requires a non-empty string id.');
    }
    if (typeof migration.up !== 'function') {
      throw new Error(`Migration "${migration.id}" requires an up(client) function.`);
    }
    if (seen.has(migration.id)) {
      throw new Error(`Duplicate migration id "${migration.id}".`);
    }
    seen.add(migration.id);
  }
}

/**
 * A minimal, honest migration runner — not a DSL, not a CLI, not schema
 * introspection. It runs your plain SQL (or query calls) in order, once
 * each, tracked by id in a ledger table. That is the whole feature: given
 * an array of { id, up(client) }, apply whichever ids aren't in the ledger
 * yet, each inside its own transaction, recording success before moving on.
 *
 * const runner = createPostgresMigrationRunner({ pool });
 * await runner.run([
 *   { id: '2026-01-01-add-users-name', up: (client) => client.query('ALTER TABLE astratra_users ADD COLUMN name TEXT') }
 * ]);
 */
function createPostgresMigrationRunner(options = {}) {
  const { pool } = options;
  if (!pool) {
    throw new Error('createPostgresMigrationRunner requires options.pool.');
  }
  const table = options.migrationsTable || DEFAULT_MIGRATIONS_TABLE;
  assertValidIdentifier(table, 'migrationsTable');

  // Memoized (like the CRUD stores' own `ready` promise) so the DDL runs
  // exactly once per runner instance — running "CREATE TABLE IF NOT
  // EXISTS" redundantly is harmless against a real Postgres, but appliedIds()
  // and run() both need the table to exist, and re-issuing the same DDL
  // needlessly on every call is wasteful regardless of the target database.
  const ledgerReady = pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      applied_at TEXT
    )
  `);

  return {
    async appliedIds() {
      await ledgerReady;
      const result = await pool.query(`SELECT id FROM ${table} ORDER BY applied_at ASC`);
      return result.rows.map((row) => row.id);
    },

    async run(migrations) {
      assertMigrationsShape(migrations);
      await ledgerReady;

      const alreadyApplied = new Set(await this.appliedIds());
      const applied = [];

      for (const migration of migrations) {
        if (alreadyApplied.has(migration.id)) continue;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await migration.up(client);
          await client.query(`INSERT INTO ${table} (id, applied_at) VALUES ($1, $2)`, [migration.id, new Date().toISOString()]);
          await client.query('COMMIT');
          applied.push(migration.id);
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`Migration "${migration.id}" failed and was rolled back: ${error.message}`);
        } finally {
          client.release();
        }
      }

      return { applied };
    }
  };
}

module.exports = {
  createPostgresMigrationRunner
};
