/* global structuredClone */
const { normalizeScope, sameScope, rowId, versionMetadata } = require('./context');
const copy = value => structuredClone(value);

/** Retire the previous current version; never expire the current one. */
function append(rows, build, retentionMs) {
  const version = (rows.at(-1)?.version || 0) + 1;
  const row = build(version);
  if (row.version !== version || !Number.isFinite(new Date(row.updatedAt).getTime())) throw new Error('Invalid version row.');
  const result = copy(rows);
  if (result.length) {
    result.at(-1).retiredAt = row.updatedAt;
    result.at(-1).expiresAt = new Date(new Date(row.updatedAt).getTime() + retentionMs);
  }
  result.push(copy(row));
  return result;
}
function purge(rows, at) {
  let count = 0;
  for (const row of rows.slice(0, -1)) {
    if (!row.purged && row.expiresAt && new Date(row.expiresAt).getTime() <= at.getTime()) {
      delete row.value;
      row.purged = true;
      count++;
    }
  }
  return count;
}

/** Each append is synchronous until its atomic in-memory commit. */
function createMemoryVersionedCredentialStore() {
  const histories = new Map();
  return {
    supportsScopes: true,
    async findAll(scope) {
      scope = normalizeScope(scope);
      return [...histories.values()].map(rows => rows.at(-1)).filter(row => sameScope(row, scope)).map(copy);
    },
    async upsert() { throw new Error('Use appendVersion for a versioned store.'); },
    async appendVersion(key, scope, build, retentionMs) {
      scope = normalizeScope(scope);
      const id = rowId(key, scope);
      const rows = append(histories.get(id) || [], build, retentionMs);
      if (rows.at(-1).key !== key || !sameScope(rows.at(-1), scope)) throw new Error('Invalid version scope.');
      histories.set(id, rows);
      return copy(rows.at(-1));
    },
    async findVersion(key, version, scope) {
      return copy((histories.get(rowId(key, normalizeScope(scope))) || []).find(row => row.version === version) || null);
    },
    async listVersions(key, scope) {
      return (histories.get(rowId(key, normalizeScope(scope))) || []).slice().reverse().map(versionMetadata);
    },
    async purgeVersions(at, scope) {
      scope = normalizeScope(scope);
      let count = 0;
      for (const rows of histories.values()) if (sameScope(rows.at(-1), scope)) count += purge(rows, at);
      return count;
    }
  };
}

/** One document per scoped key; Mongo's unique _id plus revision CAS avoids lost writes.
 * Use a dedicated collection. History grows with writes; applications must archive
 * metadata before Mongo's document-size limit when using long-lived high-volume keys.
 */
function createMongoVersionedCredentialStore({ collection, isReady = () => true, maxTimeMS = 3000 } = {}) {
  if (!collection || !['find', 'findOne', 'updateOne', 'insertOne'].every(method => typeof collection[method] === 'function')) {
    throw new Error('A Mongo collection with find/findOne/updateOne/insertOne is required.');
  }
  const ready = () => { if (!isReady()) throw new Error('Credential store unavailable.'); };
  const filterScope = scope => normalizeScope(scope) || { tenant: null, environment: null };
  async function documents(scope) {
    ready();
    return collection.find(filterScope(scope), { maxTimeMS }).toArray();
  }
  async function mutate(id, change) {
    for (let attempt = 0; attempt < 32; attempt++) {
      ready();
      const old = await collection.findOne({ _id: id }, { maxTimeMS });
      const next = change(copy(old));
      if (!old) {
        try { await collection.insertOne({ _id: id, revision: 1, ...next }); return next; }
        catch (error) { if (error.code === 11000) continue; throw new Error('Credential store write failed.'); }
      }
      const result = await collection.updateOne({ _id: id, revision: old.revision },
        { $set: { ...next, revision: old.revision + 1 } });
      if (result.matchedCount === 1) return next;
    }
    throw new Error('Credential store write contention.');
  }
  return {
    supportsScopes: true,
    async findAll(scope) { return (await documents(scope)).map(doc => copy(doc.versions.at(-1))); },
    async upsert() { throw new Error('Use appendVersion for a versioned store.'); },
    async appendVersion(key, scope, build, retentionMs) {
      scope = normalizeScope(scope);
      const doc = await mutate(rowId(key, scope), old => {
        const versions = append(old?.versions || [], build, retentionMs);
        if (versions.at(-1).key !== key || !sameScope(versions.at(-1), scope)) throw new Error('Invalid version scope.');
        return { key, ...(scope || { tenant: null, environment: null }), versions };
      });
      return copy(doc.versions.at(-1));
    },
    async findVersion(key, version, scope) {
      ready();
      const doc = await collection.findOne({ _id: rowId(key, normalizeScope(scope)) }, { maxTimeMS });
      return copy(doc?.versions.find(row => row.version === version) || null);
    },
    async listVersions(key, scope) {
      ready();
      const doc = await collection.findOne({ _id: rowId(key, normalizeScope(scope)) }, { maxTimeMS });
      return (doc?.versions || []).slice().reverse().map(versionMetadata);
    },
    async purgeVersions(at, scope) {
      let count = 0;
      for (const doc of await documents(scope)) {
        let changed = 0;
        await mutate(doc._id, old => {
          changed = purge(old.versions, at);
          return { key: old.key, tenant: old.tenant, environment: old.environment, versions: old.versions };
        });
        count += changed;
      }
      return count;
    }
  };
}
module.exports = { createMemoryVersionedCredentialStore, createMongoVersionedCredentialStore };
