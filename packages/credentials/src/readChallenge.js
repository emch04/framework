/* global structuredClone */
const crypto = require('crypto');
const { normalizeScope } = require('./context');

/** Stores must consume atomically BEFORE the verifier runs, including on failure. */
function createMemoryReadChallengeStore() {
  const records = new Map();
  return {
    async save(record) { records.set(record.id, structuredClone(record)); },
    async consume(id, subjectId) {
      const record = records.get(id);
      if (!record || record.subjectId !== String(subjectId)) return null;
      records.delete(id);
      return structuredClone(record);
    }
  };
}
function createMongoReadChallengeStore({ collection } = {}) {
  if (!collection || typeof collection.insertOne !== 'function' || typeof collection.findOneAndDelete !== 'function') {
    throw new Error('A Mongo collection with insertOne/findOneAndDelete is required.');
  }
  return {
    async save(record) { await collection.insertOne({ ...record, _id: record.id }); },
    async consume(id, subjectId) {
      return collection.findOneAndDelete({ _id: id, subjectId: String(subjectId) }, { includeResultMetadata: false });
    }
  };
}

/** A verifier (e.g. an application's passkey verifier) authorises ONE bound read. */
function createReadChallenge({ store, verify, ttlMs = 60_000, now = Date.now } = {}) {
  if (!store || !['save', 'consume'].every(method => typeof store[method] === 'function') || typeof verify !== 'function') {
    throw new Error('A read challenge requires an atomic store and a verifier.');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) throw new Error('ttlMs must be within five minutes.');
  const refused = () => new Error('Credential read challenge refused.');
  return {
    async request(subjectId, { key, version, scope } = {}) {
      if (typeof key !== 'string' || !key || (version !== undefined && (!Number.isSafeInteger(version) || version < 1))) throw refused();
      const record = { id: crypto.randomUUID(), nonce: crypto.randomBytes(32).toString('base64url'),
        subjectId: String(subjectId), key, ...(version === undefined ? {} : { version }),
        scope: normalizeScope(scope), expiresAt: new Date(now() + ttlMs) };
      await store.save(record);
      return structuredClone(record);
    },
    async read(subjectId, id, proof, vault) {
      let record;
      try { record = await store.consume(id, subjectId); } catch { throw refused(); }
      const expiresAt = new Date(record?.expiresAt).getTime();
      if (!record || record.id !== id || record.subjectId !== String(subjectId) ||
          !Number.isFinite(expiresAt) || expiresAt <= now()) throw refused();
      if (!vault || JSON.stringify(vault.scope || null) !== JSON.stringify(record.scope)) throw refused();
      let valid;
      try { valid = await verify({ challenge: structuredClone(record), proof }); } catch { throw refused(); }
      if (valid !== true || new Date(record.expiresAt).getTime() <= now()) throw refused();
      return vault.get(record.key, record.version === undefined ? {} : { version: record.version });
    }
  };
}
module.exports = { createReadChallenge, createMemoryReadChallengeStore, createMongoReadChallengeStore };
