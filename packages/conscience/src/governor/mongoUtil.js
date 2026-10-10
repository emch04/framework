'use strict';
const { prefixOf, copy } = require('./util');

function collections(db, options, fallback, suffixes) {
  if (!db || typeof db.collection !== 'function') throw new TypeError('A native MongoDB Db is required.');
  const prefix = prefixOf(options, fallback);
  return Object.fromEntries(suffixes.map((name) => [name, db.collection(`${prefix}_${name}`)]));
}
const read = (row) => copy(row?.data ?? null);
const keyOf = (...parts) => JSON.stringify(parts);
const literal = (value) => ({ $literal: copy(value) });

async function insertOnce(collection, key, data, extra = {}) {
  const document = { _id: key, data: copy(data), ...extra };
  try {
    await collection.insertOne(document);
    return { record: copy(data), created: true };
  } catch (error) {
    if (error.code !== 11000) throw error;
    const old = await collection.findOne({ _id: key });
    if (!old) throw error;
    return { record: read(old), created: false };
  }
}
async function sequence(collection, name) {
  const row = await collection.findOneAndUpdate({ _id: name }, { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after', includeResultMetadata: false });
  return row.value;
}
async function list(collection, filter, sort, limit) {
  return (await collection.find(filter).sort(sort).limit(limit).toArray()).map(read);
}
module.exports = { collections, read, keyOf, literal, insertOnce, sequence, list };
