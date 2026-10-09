'use strict';
const GROUPS = Object.freeze(['agent', 'mode', 'reason', 'day']);
const copy = (value) => (value == null ? null : { ...value });
const mapKey = (r) => `${r.tenantId ?? ''}\u0000${r.userId}\u0000${r.runId}`;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function matches(record, filter = {}) {
  if (filter.tenantId !== undefined && (filter.tenantId ?? null) !== record.tenantId) return false;
  for (const field of ['userId', 'runId', 'rating', 'reason', 'agent', 'mode']) if (filter[field] != null && filter[field] !== record[field]) return false;
  if (filter.since != null && record.updatedAt < filter.since) return false;
  if (filter.until != null && record.updatedAt >= filter.until) return false;
  return true;
}

/** Memory store: copies on every read and write; lost when the process exits. */
function createMemoryFeedbackStore() {
  const records = new Map();
  return {
    async put(record) {
      const key = mapKey(record);
      const old = records.get(key);
      const next = old ? { ...record, id: old.id, createdAt: old.createdAt } : { ...record };
      records.set(key, next);
      return { record: copy(next), created: !old };
    },
    async get(key) { return copy(records.get(mapKey(key))); },
    async remove(key) { return records.delete(mapKey(key)); },
    async list(filter = {}) {
      const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 1000);
      return [...records.values()].filter((r) => matches(r, filter)).sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1)).slice(0, limit).map(copy);
    },
    async aggregate(filter = {}) {
      if (filter.groupBy != null && !GROUPS.includes(filter.groupBy)) throw new Error('Unknown groupBy.');
      const rows = new Map();
      for (const r of records.values()) {
        if (!matches(r, filter)) continue;
        if (filter.groupBy === 'reason' && r.rating !== 'down') continue;
        const key = filter.groupBy == null ? null : filter.groupBy === 'day' ? dayOf(r.updatedAt) : r[filter.groupBy];
        const row = rows.get(key) || { key, up: 0, down: 0 };
        row[r.rating] += 1; rows.set(key, row);
      }
      return [...rows.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
    }
  };
}
module.exports = { createMemoryFeedbackStore, GROUPS };
