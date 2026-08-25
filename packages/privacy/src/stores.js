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

module.exports = { createMemoryErasureStore };
