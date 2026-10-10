'use strict';
// Minimal native-driver double: predicates, atomic updates, unique identities,
// ordered cursors, and serialized transactions with rollback.
const { copy } = require('../src/governor/util');
const path = (row, name) => name.split('.').reduce((v, k) => v?.[k], row);
function expression(value, row) {
  if (typeof value === 'string' && value.startsWith('$')) return path(row, value.slice(1));
  if (Array.isArray(value)) return value.map((v) => expression(v, row));
  if (!value || typeof value !== 'object') return value;
  if ('$literal' in value) return value.$literal;
  if ('$ifNull' in value) { const [a, b] = expression(value.$ifNull, row); return a ?? b; }
  if ('$size' in value) return expression(value.$size, row).length;
  if ('$mergeObjects' in value) return Object.assign({}, ...expression(value.$mergeObjects, row));
  const [operator, args] = Object.entries(value)[0];
  const [a, b] = expression(args, row);
  if (operator === '$eq') return a === b;
  if (operator === '$gte') return a >= b;
  throw new Error(`Unsupported expression ${operator}`);
}
function matches(row, filter) {
  return Object.entries(filter).every(([field, value]) => {
    if (field === '$expr') return expression(value, row);
    if (field === '$and') return value.every((f) => matches(row, f));
    const actual = path(row, field);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return actual === value;
    return Object.entries(value).every(([op, expected]) => {
      if (op === '$eq') return Array.isArray(actual) ? actual.includes(expected) : (actual ?? null) === expected;
      if (op === '$ne') return (actual ?? null) !== expected;
      if (op === '$in') return expected.includes(actual);
      if (op === '$gte') return actual != null && actual >= expected;
      if (op === '$lte') return actual != null && actual <= expected;
      if (op === '$lt') return actual != null && actual < expected;
      throw new Error(`Unsupported predicate ${op}`);
    });
  });
}
function fakeDatabase() {
  const tables = new Map();
  let queue = Promise.resolve();
  const db = {
    client: { startSession() { return {
      async withTransaction(fn) {
        const previous = queue; let release;
        queue = new Promise((resolve) => { release = resolve; });
        await previous;
        const snapshot = new Map([...tables].map(([name, table]) => [name, copy(table.rows)]));
        try { return await fn(); } catch (error) {
          for (const [name, rows] of snapshot) tables.get(name).rows = rows;
          throw error;
        } finally { release(); }
      }, async endSession() {}
    }; } },
    collection(name) {
      if (tables.has(name)) return tables.get(name);
      const table = {
        rows: [], indexes: [],
        async createIndex(fields, options) { this.indexes.push({ fields, options }); },
        async insertOne(row) {
          if (this.rows.some((r) => r._id === row._id || (name.endsWith('_audit') && r.data.id === row.data.id))) throw Object.assign(new Error('duplicate'), { code: 11000 });
          this.rows.push(copy(row)); return { insertedId: row._id };
        },
        async findOne(filter) { return copy(this.rows.find((r) => matches(r, filter))); },
        find(filter) {
          let rows = this.rows.filter((r) => matches(r, filter));
          return {
            sort(fields) { rows.sort((a, b) => {
              for (const [field, direction] of Object.entries(fields)) {
                const x = path(a, field), y = path(b, field);
                if (x < y) return -direction; if (x > y) return direction;
              } return 0;
            }); return this; },
            limit(n) { rows = rows.slice(0, n); return this; },
            async toArray() { return copy(rows); }
          };
        },
        async findOneAndUpdate(filter, update, options = {}) {
          let row = this.rows.find((r) => matches(r, filter));
          let inserted = false;
          if (!row && options.upsert) { row = copy(filter); this.rows.push(row); inserted = true; }
          if (!row) return null;
          if (Array.isArray(update)) Object.assign(row, Object.fromEntries(Object.entries(update[0].$set).map(([k, v]) => [k, expression(v, row)])));
          else {
            if (inserted) Object.assign(row, copy(update.$setOnInsert ?? {}));
            Object.assign(row, copy(update.$set ?? {}));
            for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + value;
          }
          return copy(row);
        },
        async updateOne(filter, update, options) { return this.findOneAndUpdate(filter, update, options); },
        async deleteMany(filter) {
          const old = this.rows.length; this.rows = this.rows.filter((r) => !matches(r, filter));
          return { deletedCount: old - this.rows.length };
        }
      };
      tables.set(name, table); return table;
    }
  };
  return db;
}
module.exports = { fakeDatabase };
