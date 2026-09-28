/**
 * An in-process store for tests and local development.
 *
 * Not persistent. An erasure log that vanishes on restart is not an audit
 * trail — use a real table in production.
 */
function createMemoryErasureStore() {
  const records = new Map();
  let sequence = 0;

  const clone = (record) => (record ? JSON.parse(JSON.stringify(record)) : record);

  return {
    async create(data) {
      const id = String(++sequence);
      const record = { id, ...data };
      records.set(id, record);
      return clone(record);
    },
    async find(id) {
      return clone(records.get(String(id))) || null;
    },
    async update(id, patch) {
      const record = records.get(String(id));
      if (!record) return null;
      Object.assign(record, patch);
      return clone(record);
    },
    async list(filter = {}) {
      return [...records.values()]
        .filter((record) => Object.entries(filter).every(([key, value]) => record[key] === value))
        .map(clone);
    },
    size: () => records.size
  };
}

/*
 * Values compared the way a database compares them: two Dates are equal when
 * they point at the same instant, and a missing field equals null — a
 * compare-and-set on `reminderFor: null` must match a record that never had
 * one.
 */
function sameValue(a, b) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a instanceof Date || b instanceof Date) {
    if (a === null || b === null) return false;
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return a === b;
}

function matchesCondition(actual, condition) {
  if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
    if (actual === undefined || actual === null) return false;
    const at = new Date(actual).getTime();
    if ('lt' in condition && !(at < new Date(condition.lt).getTime())) return false;
    if ('lte' in condition && !(at <= new Date(condition.lte).getTime())) return false;
    if ('gt' in condition && !(at > new Date(condition.gt).getTime())) return false;
    return true;
  }
  return sameValue(actual, condition);
}

/**
 * The contract of the self-service deletion store, in memory.
 *
 * One record per subject. Every write is CONDITIONAL — `expected` lists the
 * fields that must still hold — because two instances of the sweep, or a
 * sign-in racing it, would otherwise both believe they won. In MongoDB each
 * method is one `updateOne`/`deleteOne` filtered on `{ subject, ...expected }`;
 * in SQL, an UPDATE … WHERE with the same columns.
 *
 * Not persistent: a deletion schedule that vanishes on restart erases nothing,
 * or keeps suspended an account no one will ever erase.
 */
function createMemoryDeletionStore() {
  const records = new Map();
  const keyOf = (subject) => String(subject);
  const copy = (record) => (record ? { ...record } : null);

  return {
    async get(subject) {
      return copy(records.get(keyOf(subject)));
    },
    /** Insert; false if the subject already has a record. */
    async create(record) {
      const key = keyOf(record.subject);
      if (records.has(key)) return false;
      records.set(key, { ...record });
      return true;
    },
    /** Patch only if every `expected` field still holds. */
    async update(subject, expected, patch) {
      const record = records.get(keyOf(subject));
      if (!record) return false;
      if (!Object.entries(expected || {}).every(([field, value]) => sameValue(record[field], value))) return false;
      Object.assign(record, patch);
      return true;
    },
    /** Delete only if every `expected` field still holds. */
    async remove(subject, expected) {
      const key = keyOf(subject);
      const record = records.get(key);
      if (!record) return false;
      if (!Object.entries(expected || {}).every(([field, value]) => sameValue(record[field], value))) return false;
      records.delete(key);
      return true;
    },
    /** Equality, or { lt, lte, gt } on dates. */
    async list(filter = {}) {
      return [...records.values()]
        .filter((record) => Object.entries(filter).every(([field, condition]) => matchesCondition(record[field], condition)))
        .map(copy);
    },
    size: () => records.size
  };
}

/**
 * The consent store contract, in memory.
 *
 *   get(subject, scope)      -> record | null
 *   put(record)              -> void   (upsert on subject + scope)
 *   list(subject)            -> records of that subject only
 *   remove(subject, scope?)  -> number removed (every scope when omitted)
 *
 * A record is { subject, scope, granted, version, decidedAt }. One row per
 * subject and scope: a new decision REPLACES the previous one — the latest
 * decision is the one that counts, and keeping an older yes next to a newer no
 * is how a withdrawal gets lost. In MongoDB: a unique index on
 * { subject, scope } and updateOne(..., { upsert: true }).
 *
 * Not persistent: a consent that vanishes on restart asks everyone again, or —
 * worse, with a cache in front — lets an old yes stand.
 */
function createMemoryConsentStore() {
  const rows = new Map();
  const keyOf = (subject, scope) => `${String(subject)}\u0000${String(scope)}`;
  const copy = (row) => (row ? { ...row } : null);

  return {
    async get(subject, scope) {
      return copy(rows.get(keyOf(subject, scope))) || null;
    },
    async put(record) {
      rows.set(keyOf(record.subject, record.scope), { ...record, subject: String(record.subject) });
    },
    async list(subject) {
      return [...rows.values()].filter((row) => row.subject === String(subject)).map(copy);
    },
    async remove(subject, scope) {
      let removed = 0;
      for (const [key, row] of rows) {
        if (row.subject === String(subject) && (scope === undefined || row.scope === scope)) {
          rows.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    size: () => rows.size
  };
}

module.exports = { createMemoryErasureStore, createMemoryDeletionStore, createMemoryConsentStore };
