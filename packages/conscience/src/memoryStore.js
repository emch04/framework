'use strict';
const { copy } = require('./governor/util');

const MAX_LIMIT = 10000;
const limitOf = (value) => Math.min(Math.max(Number(value) || 1000, 1), MAX_LIMIT);
const keyOf = (kind, organisationId, id) => `${kind}\u0000${organisationId}\u0000${id}`;

/** True when an envelope passes a list filter. Shared with tests of other stores. */
function matchesFilter(row, filter) {
  if (row.organisationId !== filter.organisationId) return false;
  for (const field of ['userId', 'agentId', 'decisionId', 'lessonId']) {
    if (filter[field] !== undefined && row[field] !== filter[field]) return false;
  }
  if (Array.isArray(filter.decisionIds) && !filter.decisionIds.includes(row.decisionId)) return false;
  if (filter.evidenceRef != null && !(row.evidenceRefs || []).includes(filter.evidenceRef)) return false;
  if (filter.eventFrom != null && (row.eventAt == null || row.eventAt < filter.eventFrom)) return false;
  if (filter.eventTo != null && (row.eventAt == null || row.eventAt >= filter.eventTo)) return false;
  if (filter.recordedTo != null && row.recordedAt > filter.recordedTo) return false;
  return true;
}

/**
 * Conscience store kept in memory. Records are immutable envelopes
 * `{ kind, id, organisationId, userId, agentId, decisionId, lessonId, eventAt,
 * recordedAt, fingerprint, evidenceRefs, data }`; `put` never overwrites
 * (idempotent), `replace` and `remove` exist for erasure and retention only.
 */
function createMemoryConscienceStore() {
  const rows = new Map();
  let seq = 0;
  return {
    async put(envelope) {
      const key = keyOf(envelope.kind, envelope.organisationId, envelope.id);
      const old = rows.get(key);
      if (old) return { record: copy(old.envelope), created: false };
      seq += 1;
      rows.set(key, { seq, envelope: copy(envelope) });
      return { record: copy(envelope), created: true };
    },
    async get(kind, organisationId, id) {
      return copy(rows.get(keyOf(kind, organisationId, id))?.envelope ?? null);
    },
    async list(kind, filter = {}) {
      const found = [...rows.values()]
        .filter(({ envelope }) => envelope.kind === kind && matchesFilter(envelope, filter))
        .sort((a, b) => (a.envelope.recordedAt < b.envelope.recordedAt ? -1 : a.envelope.recordedAt > b.envelope.recordedAt ? 1 : a.seq - b.seq));
      if (filter.order === 'desc') found.reverse();
      return found.slice(0, limitOf(filter.limit)).map(({ envelope }) => copy(envelope));
    },
    async replace(envelope) {
      const key = keyOf(envelope.kind, envelope.organisationId, envelope.id);
      const old = rows.get(key);
      if (!old) return null;
      rows.set(key, { seq: old.seq, envelope: copy(envelope) });
      return copy(envelope);
    },
    async remove(kind, organisationId, ids) {
      let count = 0;
      for (const id of ids) if (rows.delete(keyOf(kind, organisationId, id))) count += 1;
      return count;
    }
  };
}

module.exports = { createMemoryConscienceStore, matchesFilter, MAX_LIMIT };
