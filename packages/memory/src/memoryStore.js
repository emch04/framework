/**
 * The reference store: in process, not persistent. Tests use it, and it is the
 * executable description of the store contract — an adapter for a real
 * database proves itself with runStoreContract() from ./testing.
 *
 * A place is `{ ownerId, scope }`. Nothing ever crosses from one place to
 * another, except purgeOwner(), which is meant to: it erases an owner
 * everywhere.
 */
const { cosine, keywordScore } = require('./ranking');

/* Deep copy that keeps Dates as Dates: what the caller holds never aliases the store. */
function copy(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = copy(item);
    return out;
  }
  return value;
}

const keyOf = (where) => `${where.ownerId}\u0000${where.scope}`;
const time = (value) => (value ? new Date(value).getTime() : 0);

function matches(record, filter = {}) {
  const state = filter.state || 'active';
  if (state === 'active' && record.supersededBy) return false;
  if (state === 'superseded' && !record.supersededBy) return false;
  if (filter.supersededBy !== undefined && record.supersededBy !== filter.supersededBy) return false;
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(record.kind)) return false;
  if (filter.channel !== undefined && (record.source || {}).channel !== filter.channel) return false;
  if (filter.seen === false && record.seenAt) return false;
  if (filter.seen === true && !record.seenAt) return false;
  if (filter.createdAfter && time(record.createdAt) < time(filter.createdAfter)) return false;
  if (filter.createdBefore && time(record.createdAt) > time(filter.createdBefore)) return false;
  return true;
}

function createMemoryStore() {
  const records = new Map();
  const settings = new Map();
  const refs = new Map();

  const clone = (value) => (value === null || value === undefined ? null : copy(value));
  const inPlace = (where, record) => record && record.ownerId === where.ownerId && record.scope === where.scope;
  const newestFirst = (a, b) => time(b.createdAt) - time(a.createdAt);

  return {
    async insert(record) {
      if (!record || !record.id) throw new Error('insert requires a record with an id.');
      if (records.has(record.id)) throw new Error(`A memory with id ${record.id} already exists.`);
      records.set(record.id, clone(record));
      return clone(record);
    },

    async get(where, id) {
      const record = records.get(String(id));
      return inPlace(where, record) ? clone(record) : null;
    },

    async list(where, filter = {}) {
      const rows = [...records.values()]
        .filter((record) => inPlace(where, record) && matches(record, filter))
        .sort(newestFirst);
      const out = (filter.limit ? rows.slice(0, filter.limit) : rows).map(clone);
      /* The vector left out when the caller does not need it: hasVector says whether there is one. */
      if (filter.withVector === false) {
        for (const record of out) {
          record.hasVector = Array.isArray(record.vector) && record.vector.length > 0;
          record.vector = null;
        }
      }
      return out;
    },

    async update(where, id, patch, options = {}) {
      const record = records.get(String(id));
      if (!inPlace(where, record)) return null;
      if (options.onlyActive && record.supersededBy) return null;
      const allowed = clone(patch || {});
      /* A record never changes identity or place through an update. */
      delete allowed.id;
      delete allowed.ownerId;
      delete allowed.scope;
      Object.assign(record, allowed);
      return clone(record);
    },

    async remove(where, ids) {
      let removed = 0;
      for (const id of ids || []) {
        if (inPlace(where, records.get(String(id)))) {
          records.delete(String(id));
          removed += 1;
        }
      }
      return removed;
    },

    async removeAll(where) {
      let removed = 0;
      for (const [id, record] of records) {
        if (inPlace(where, record)) {
          records.delete(id);
          removed += 1;
        }
      }
      return removed;
    },

    async purgeOwner(ownerId) {
      const counts = { memories: 0, settings: 0, refs: 0 };
      for (const [id, record] of records) {
        if (record.ownerId === ownerId) { records.delete(id); counts.memories += 1; }
      }
      const prefix = `${ownerId}\u0000`;
      for (const key of [...settings.keys()]) {
        if (key.startsWith(prefix)) { settings.delete(key); counts.settings += 1; }
      }
      for (const key of [...refs.keys()]) {
        if (key.startsWith(prefix)) { refs.delete(key); counts.refs += 1; }
      }
      return counts;
    },

    async getSettings(where) {
      return { paused: false, ...(clone(settings.get(keyOf(where))) || {}) };
    },

    async setSettings(where, patch) {
      const next = { paused: false, ...(settings.get(keyOf(where)) || {}), ...clone(patch) };
      settings.set(keyOf(where), next);
      return clone(next);
    },

    async claimRef(where, ref) {
      const key = `${keyOf(where)}\u0000${ref}`;
      if (refs.has(key)) return false;
      refs.set(key, true);
      return true;
    },

    async releaseRef(where, ref) {
      refs.delete(`${keyOf(where)}\u0000${ref}`);
    },

    /*
     * Optional in the contract: a database with a vector index answers this
     * itself. Only vectors of the query's source are compared — two embedding
     * models never share a space.
     */
    async search(where, { text, vector, vectorSource, kinds, createdAfter, createdBefore, limit = 32 } = {}) {
      const rows = [...records.values()].filter((record) => inPlace(where, record)
        && matches(record, { kinds, createdAfter, createdBefore }));
      const semantic = Array.isArray(vector)
        ? rows.filter((record) => Array.isArray(record.vector) && record.vectorSource === vectorSource && record.vector.length === vector.length)
          .map((record) => ({ record, score: cosine(vector, record.vector) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ record, score }) => ({ ...clone(record), score }))
        : [];
      const lexical = text
        ? rows.map((record) => ({ record, score: keywordScore(text, record.text) }))
          .filter((row) => row.score > 0)
          .sort((a, b) => b.score - a.score
            || time(b.record.lastUsedAt || b.record.createdAt) - time(a.record.lastUsedAt || a.record.createdAt))
          .slice(0, limit)
          .map(({ record, score }) => ({ ...clone(record), score }))
        : [];
      return { semantic, lexical };
    },

    /* Optional: active memories, every owner, with no vector or one from another source. */
    async listNeedingVector({ limit = 50, source } = {}) {
      return [...records.values()]
        .filter((record) => !record.supersededBy
          && (!Array.isArray(record.vector) || !record.vector.length || (source !== undefined && record.vectorSource !== source)))
        .sort((a, b) => (Array.isArray(a.vector) ? 1 : 0) - (Array.isArray(b.vector) ? 1 : 0) || time(a.createdAt) - time(b.createdAt))
        .slice(0, limit)
        .map(clone);
    },

    size: () => records.size
  };
}

module.exports = { createMemoryStore };
