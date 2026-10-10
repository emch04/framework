'use strict';
const { copy } = require('./util');
const { boundedLimit } = require('./stores');
const { collections, read, keyOf, literal, insertOnce, sequence, list } = require('./mongoUtil');
const suffixes = ['proposals', 'audit', 'spend', 'controls', 'objects', 'versions', 'findings', 'sequences', 'locks'];
const tables = (db, options) => collections(db, options, 'astratra_governor', suffixes);
const objectKey = (organisationId, kind, id) => keyOf(organisationId, kind, id);

/** Explicit, repeatable migration; never run implicitly by the store. */
async function mongoGovernorIndexes(db, options) {
  const t = tables(db, options);
  await t.proposals.createIndex({ 'data.organisationId': 1, 'data.status': 1, 'data.createdAt': -1, 'data.id': 1 });
  await t.audit.createIndex({ 'data.id': 1 }, { unique: true });
  await t.audit.createIndex({ 'data.organisationId': 1, seq: -1 });
  await t.spend.createIndex({ organisationId: 1, at: 1 });
  await t.objects.createIndex({ 'data.organisationId': 1, 'data.kind': 1, 'data.id': 1 });
  await t.objects.createIndex({ 'data.candidate': 1 });
  await t.versions.createIndex({ 'data.organisationId': 1, 'data.kind': 1, 'data.id': 1, 'data.number': 1 });
  await t.findings.createIndex({ 'data.organisationId': 1, 'data.receivedAt': -1, 'data.id': 1 });
  // Materialize transaction collections before the first reservation.
  for (const name of ['locks', 'controls', 'sequences']) await t[name].createIndex({ _id: 1 });
}

/** Native Db, also available as a mongoose connection's .db. No driver import. */
function createMongoGovernorStore(db, options = {}) {
  const t = tables(db, options);
  const client = options.client ?? db.client;
  if (!client || typeof client.startSession !== 'function') throw new TypeError('A MongoClient with startSession() is required.');
  const get = async (table, key) => read(await table.findOne({ _id: key }));
  return {
    putProposal(record) { return insertOnce(t.proposals, keyOf(record.organisationId, record.id), record); },
    getProposal(organisationId, id) { return get(t.proposals, keyOf(organisationId, id)); },
    async transitionProposal(organisationId, id, fromStatus, patch, guard) {
      const filter = { _id: keyOf(organisationId, id), 'data.status': fromStatus };
      if (guard?.approvals !== undefined) filter.$expr = { $eq: [{ $size: { $ifNull: ['$data.approvals', []] } }, guard.approvals] };
      return read(await t.proposals.findOneAndUpdate(filter,
        [{ $set: { data: { $mergeObjects: ['$data', literal(patch)] } } }],
        { returnDocument: 'after', includeResultMetadata: false }));
    },
    listProposals(filter = {}) {
      const query = { 'data.organisationId': filter.organisationId };
      if (filter.status != null) query['data.status'] = { $eq: filter.status };
      if (filter.statuses != null) query.$and = [{ 'data.status': { $in: filter.statuses } }];
      if (filter.since != null) query.$expr = { $gte: [{ $ifNull: ['$data.decidedAt', '$data.createdAt'] }, literal(filter.since)] };
      return list(t.proposals, query, { 'data.createdAt': -1, 'data.id': 1 }, boundedLimit(filter.limit));
    },
    async appendAudit(entry) {
      const seq = await sequence(t.sequences, 'audit');
      await t.audit.insertOne({ _id: entry.id, data: copy(entry), seq });
      return copy(entry);
    },
    listAudit(filter = {}) {
      const query = {};
      for (const field of ['organisationId', 'proposalId', 'objectKind', 'objectId']) {
        if (filter[field] !== undefined && (field === 'organisationId' || filter[field] != null)) query[`data.${field}`] = { $eq: filter[field] };
      }
      if (filter.actions != null) query['data.action'] = { $in: filter.actions };
      if (filter.since != null) query['data.at'] = { $gte: filter.since };
      return list(t.audit, query, { seq: -1 }, boundedLimit(filter.limit));
    },
    async reserveSpend(entry, limits) {
      if (!Number.isFinite(entry.cost) || entry.cost < 0) throw new TypeError('Spend cost must be finite and nonnegative.');
      // A permanent organisation lock document is updated in every transaction.
      // Conflicting reservations retry through withTransaction, with a new snapshot.
      try {
        await t.locks.updateOne({ _id: entry.organisationId }, { $setOnInsert: { revision: 0 } }, { upsert: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        if (!await t.locks.findOne({ _id: entry.organisationId })) throw error;
      }
      const session = client.startSession();
      try {
        return await session.withTransaction(async () => {
          await t.locks.updateOne({ _id: entry.organisationId }, { $inc: { revision: 1 } }, { session });
          const rows = await t.spend.find({ organisationId: entry.organisationId }, { session }).toArray();
          const sums = () => {
            const totals = { cycle: 0, agent: 0, organisation: 0 };
            for (const row of rows) {
              if (entry.cycleId != null && row.cycleId === entry.cycleId) totals.cycle += row.cost;
              if (row.at >= limits.since) {
                totals.organisation += row.cost;
                if (row.agentId === entry.agentId) totals.agent += row.cost;
              }
            }
            return totals;
          };
          if (rows.some((row) => row._id === keyOf(entry.organisationId, entry.id))) return { reserved: true, created: false, totals: sums() };
          const totals = sums();
          if ((entry.cycleId != null && totals.cycle + entry.cost > limits.perCycle)
            || totals.agent + entry.cost > limits.perAgent || totals.organisation + entry.cost > limits.perOrganisation) return { reserved: false, created: false, totals };
          const row = { ...copy(entry), _id: keyOf(entry.organisationId, entry.id) };
          await t.spend.insertOne(row, { session });
          rows.push(row);
          return { reserved: true, created: true, totals: sums() };
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
      } finally { await session.endSession(); }
    },
    getControl(key) { return get(t.controls, key); },
    async setControl(key, value) {
      await t.controls.updateOne({ _id: key }, { $set: { data: copy(value) } }, { upsert: true });
      return copy(value);
    },
    getObject(organisationId, kind, id) { return get(t.objects, objectKey(organisationId, kind, id)); },
    createObject(state) { return insertOnce(t.objects, objectKey(state.organisationId, state.kind, state.id), state); },
    async updateObject(organisationId, kind, id, expectedRevision, next) {
      return read(await t.objects.findOneAndUpdate({ _id: objectKey(organisationId, kind, id), 'data.revision': expectedRevision },
        { $set: { data: copy(next) } }, { returnDocument: 'after', includeResultMetadata: false }));
    },
    listObjects(filter = {}) {
      const query = {};
      for (const field of ['organisationId', 'kind']) if (filter[field] != null) query[`data.${field}`] = { $eq: filter[field] };
      if (filter.hasCandidate) query['data.candidate'] = { $ne: null };
      return list(t.objects, query, { 'data.organisationId': 1, 'data.kind': 1, 'data.id': 1 }, boundedLimit(filter.limit));
    },
    putVersion(record) { return insertOnce(t.versions, keyOf(record.organisationId, record.kind, record.id, record.versionId), record); },
    getVersion(organisationId, kind, id, versionId) { return get(t.versions, keyOf(organisationId, kind, id, versionId)); },
    listVersions(filter) {
      return list(t.versions, { 'data.organisationId': filter.organisationId, 'data.kind': filter.kind, 'data.id': filter.id }, { 'data.number': 1 }, boundedLimit(filter.limit, 1000));
    },
    putFinding(record) { return insertOnce(t.findings, keyOf(record.organisationId, record.id), record); },
    listFindings(filter = {}) {
      const query = { 'data.organisationId': filter.organisationId };
      if (filter.since != null || filter.until != null) {
        query['data.receivedAt'] = {};
        if (filter.since != null) query['data.receivedAt'].$gte = filter.since;
        if (filter.until != null) query['data.receivedAt'].$lte = filter.until;
      }
      return list(t.findings, query, { 'data.receivedAt': -1, 'data.id': 1 }, boundedLimit(filter.limit));
    }
  };
}
module.exports = { createMongoGovernorStore, mongoGovernorIndexes };
