'use strict';
const { copy } = require('./governor/util');
const { MAX_LIMIT } = require('./memoryStore');
const { collections, read, keyOf, insertOnce, sequence, list } = require('./governor/mongoUtil');
const tables = (db, options) => collections(db, options, 'astratra_conscience', ['records', 'sequences']);
const key = (e) => keyOf(e.organisationId, e.kind, e.id);

/** Explicit, repeatable migration. Identity uses MongoDB's unique _id index. */
async function mongoConscienceIndexes(db, options) {
  const t = tables(db, options);
  for (const fields of [
    { 'data.organisationId': 1, 'data.kind': 1, 'data.recordedAt': 1, seq: 1 },
    { 'data.organisationId': 1, 'data.userId': 1 },
    { 'data.organisationId': 1, 'data.kind': 1, 'data.decisionId': 1 },
    { 'data.organisationId': 1, 'data.kind': 1, 'data.lessonId': 1 },
    { 'data.organisationId': 1, 'data.kind': 1, 'data.eventAt': 1 },
    { 'data.organisationId': 1, 'data.evidenceRefs': 1 }
  ]) await t.records.createIndex(fields);
  await t.sequences.createIndex({ _id: 1 });
}
function createMongoConscienceStore(db, options) {
  const t = tables(db, options);
  return {
    async put(envelope) {
      return insertOnce(t.records, key(envelope), envelope, { seq: await sequence(t.sequences, 'records') });
    },
    async get(kind, organisationId, id) { return read(await t.records.findOne({ _id: keyOf(organisationId, kind, id) })); },
    list(kind, filter = {}) {
      const query = { 'data.organisationId': filter.organisationId, 'data.kind': kind };
      for (const field of ['userId', 'agentId', 'decisionId', 'lessonId']) if (filter[field] !== undefined) query[`data.${field}`] = { $eq: filter[field] };
      if (Array.isArray(filter.decisionIds)) query.$and = [{ 'data.decisionId': { $in: filter.decisionIds } }];
      if (filter.evidenceRef != null) query['data.evidenceRefs'] = { $eq: filter.evidenceRef };
      if (filter.eventFrom != null || filter.eventTo != null) {
        query['data.eventAt'] = { $ne: null };
        if (filter.eventFrom != null) query['data.eventAt'].$gte = filter.eventFrom;
        if (filter.eventTo != null) query['data.eventAt'].$lt = filter.eventTo;
      }
      if (filter.recordedTo != null) query['data.recordedAt'] = { $lte: filter.recordedTo };
      const order = filter.order === 'desc' ? -1 : 1;
      return list(t.records, query, { 'data.recordedAt': order, seq: order }, Math.min(Math.max(Number(filter.limit) || 1000, 1), MAX_LIMIT));
    },
    async replace(envelope) {
      return read(await t.records.findOneAndUpdate({ _id: key(envelope) }, { $set: { data: copy(envelope) } },
        { returnDocument: 'after', includeResultMetadata: false }));
    },
    async remove(kind, organisationId, ids) {
      if (!ids.length) return 0;
      return (await t.records.deleteMany({ _id: { $in: ids.map((id) => keyOf(organisationId, kind, id)) } })).deletedCount;
    }
  };
}
module.exports = { createMongoConscienceStore, mongoConscienceIndexes };
