const DEFAULT_MIGRATIONS_COLLECTION = 'astratra_migrations';

function assertMigrationsShape(migrations) {
  if (!Array.isArray(migrations)) {
    throw new Error('createMongoMigrationRunner.run requires an array of migrations.');
  }
  const seen = new Set();
  for (const migration of migrations) {
    if (!migration || typeof migration.id !== 'string' || !migration.id) {
      throw new Error('Every migration requires a non-empty string id.');
    }
    if (typeof migration.up !== 'function') {
      throw new Error(`Migration "${migration.id}" requires an up(connection) function.`);
    }
    if (seen.has(migration.id)) {
      throw new Error(`Duplicate migration id "${migration.id}".`);
    }
    seen.add(migration.id);
  }
}

/**
 * A minimal, honest migration runner — not a DSL, not a CLI, not schema
 * diffing. It runs your plain code (index creation, backfills, document
 * reshaping) in order, once each, tracked by id in a ledger collection.
 * Given an array of { id, up(connection) }, applies whichever ids aren't in
 * the ledger yet, in order, recording each as applied before moving to the
 * next. Mongo has no cross-collection transactions on a standalone
 * deployment, so unlike the Postgres runner this does NOT wrap each
 * migration in a transaction — write migrations that are safe to record as
 * applied even if a later step in the same "up" fails partway (or use a
 * replica set + session if you need atomicity).
 *
 * const runner = createMongoMigrationRunner({ connection });
 * await runner.run([
 *   { id: '2026-01-01-index-users-role', up: (conn) => conn.collection('astratra_users').createIndex({ role: 1 }) }
 * ]);
 */
function createMongoMigrationRunner(options = {}) {
  const { connection } = options;
  if (!connection) {
    throw new Error('createMongoMigrationRunner requires options.connection.');
  }
  const collectionName = options.migrationsCollection || DEFAULT_MIGRATIONS_COLLECTION;

  async function ready() {
    if (connection.readyState === 0 && typeof connection.asPromise === 'function') {
      await connection.asPromise();
    }
    return connection.collection(collectionName);
  }

  return {
    async appliedIds() {
      const ledger = await ready();
      const docs = await ledger.find({}).sort({ appliedAt: 1 }).toArray();
      return docs.map((doc) => doc.id);
    },

    async run(migrations) {
      assertMigrationsShape(migrations);
      const ledger = await ready();

      const alreadyApplied = new Set(await this.appliedIds());
      const applied = [];

      for (const migration of migrations) {
        if (alreadyApplied.has(migration.id)) continue;

        try {
          await migration.up(connection);
          await ledger.insertOne({ id: migration.id, appliedAt: new Date() });
          applied.push(migration.id);
        } catch (error) {
          throw new Error(`Migration "${migration.id}" failed: ${error.message}`);
        }
      }

      return { applied };
    }
  };
}

module.exports = {
  createMongoMigrationRunner
};
