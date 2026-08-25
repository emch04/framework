/**
 * Persistence adapters.
 *
 * The vault never talks to a database itself — it talks to one of these, or to
 * whatever you write instead. Two contracts, both tiny:
 *
 *   credential store : findAll() -> rows, upsert(row)
 *   challenge store  : find(subjectId) -> record|null, save(subjectId, record)
 *
 * A credential row is { key, value, secret, updatedAt, updatedBy }. `value` is
 * already encrypted when `secret` is true — encryption happens in the vault, so
 * an adapter never sees a plaintext secret it might log by accident.
 */

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/** In-process adapter for tests and local development. Not persistent. */
function createMemoryCredentialStore(initialRows = []) {
  const rows = new Map(initialRows.map((row) => [row.key, { ...row }]));

  return {
    async findAll() {
      return [...rows.values()].map((row) => ({ ...row }));
    },
    async upsert(row) {
      rows.set(row.key, { ...rows.get(row.key), ...row, updatedAt: row.updatedAt || new Date() });
    }
  };
}

/** In-process adapter for unlock challenges. Not persistent. */
function createMemoryChallengeStore() {
  const records = new Map();

  return {
    async find(subjectId) {
      return clone(records.get(String(subjectId))) || null;
    },
    async save(subjectId, record) {
      records.set(String(subjectId), clone(record));
    }
  };
}

/**
 * MongoDB adapter over a driver collection — `db.collection('credentials')`,
 * or `mongooseConnection.collection('credentials')`. No mongoose import, no
 * schema, no model registration.
 *
 * `isReady` matters more than it looks. Mongoose queues queries while it is
 * disconnected: without this guard a read would hang instead of falling back
 * to the environment — a frozen payment rather than a working one.
 *
 * @param {object} options
 * @param {object} options.collection  a MongoDB driver collection.
 * @param {Function} [options.isReady] () => boolean, checked before each read.
 * @param {number} [options.maxTimeMS] server-side cap on the read. Default 3000.
 */
function createMongoCredentialStore(options = {}) {
  const collection = options.collection;
  if (!collection || typeof collection.find !== 'function') {
    throw new Error('createMongoCredentialStore requires options.collection.');
  }
  const isReady = options.isReady || (() => true);
  const maxTimeMS = options.maxTimeMS || 3000;

  return {
    async findAll() {
      if (!isReady()) return [];
      const cursor = collection.find(
        {},
        { projection: { key: 1, value: 1, secret: 1, updatedAt: 1, updatedBy: 1 } }
      );
      const capped = typeof cursor.maxTimeMS === 'function' ? cursor.maxTimeMS(maxTimeMS) : cursor;
      return capped.toArray();
    },
    async upsert(row) {
      await collection.updateOne(
        { key: row.key },
        { $set: { ...row, updatedAt: row.updatedAt || new Date() } },
        { upsert: true }
      );
    }
  };
}

/** MongoDB adapter for unlock challenges, over a driver collection. */
function createMongoChallengeStore(options = {}) {
  const collection = options.collection;
  if (!collection || typeof collection.findOne !== 'function') {
    throw new Error('createMongoChallengeStore requires options.collection.');
  }

  return {
    async find(subjectId) {
      return collection.findOne({ subject: String(subjectId) });
    },
    async save(subjectId, record) {
      await collection.updateOne(
        { subject: String(subjectId) },
        { $set: { ...record, subject: String(subjectId), updatedAt: new Date() } },
        { upsert: true }
      );
    }
  };
}

module.exports = {
  createMemoryCredentialStore,
  createMemoryChallengeStore,
  createMongoCredentialStore,
  createMongoChallengeStore
};
