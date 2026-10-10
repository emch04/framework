'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMongoConscienceStore, mongoConscienceIndexes } = require('../src');
const { createMongoGovernorStore, mongoGovernorIndexes } = require('../src/governor');
const { governorContract } = require('./governorContract');
const { advancedContract } = require('./advancedContract');
const { conscienceContract } = require('./conscienceContract');
const { evaluationContract } = require('./evaluationContract');
const uri = process.env.MONGO_TEST_URL;
let client, db;
const options = { skip: !uri && 'MONGO_TEST_URL not supplied (a MongoDB replica set is required)' };
before(async () => {
  if (!uri) return;
  const { MongoClient } = require('mongodb');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect(); db = client.db();
  const hello = await db.admin().command({ hello: 1 });
  assert.ok(hello.setName || hello.msg === 'isdbgrid', 'MongoDB transactions require a replica set or sharded cluster');
});
after(async () => { await client?.close(); });
async function fresh() {
  const prefix = `test_c_${randomUUID().replaceAll('-', '')}`;
  const governorPrefix = `test_g_${randomUUID().replaceAll('-', '')}`;
  const cleanup = async () => {
    for (const name of ['records', 'sequences']) await db.collection(`${prefix}_${name}`).drop().catch((e) => { if (e.code !== 26) throw e; });
    for (const name of ['proposals', 'audit', 'spend', 'controls', 'objects', 'versions', 'findings', 'sequences', 'locks']) await db.collection(`${governorPrefix}_${name}`).drop().catch((e) => { if (e.code !== 26) throw e; });
  };
  try {
    await mongoConscienceIndexes(db, { prefix }); await mongoConscienceIndexes(db, { prefix });
    await mongoGovernorIndexes(db, { prefix: governorPrefix }); await mongoGovernorIndexes(db, { prefix: governorPrefix });
    return { store: createMongoConscienceStore(db, { prefix }), governorStore: createMongoGovernorStore(db, { prefix: governorPrefix }), prefix, governorPrefix, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
governorContract('mongo real', async () => { const s = await fresh(); return { store: s.governorStore, cleanup: s.cleanup }; }, options);
advancedContract('mongo real', async () => { const s = await fresh(); return { store: s.governorStore, cleanup: s.cleanup }; }, options);
conscienceContract('mongo real', fresh, options);
evaluationContract('mongo real', fresh, options);

test('mongo real: independent clients race budgets, approvals, revisions and immutable records', options, async () => {
  const s = await fresh();
  const { MongoClient } = require('mongodb');
  const other = new MongoClient(uri);
  try {
    await other.connect();
    const stores = [s.governorStore, createMongoGovernorStore(other.db(), { prefix: s.governorPrefix })];
    const limits = { perCycle: 2, perAgent: 2, perOrganisation: 2, since: 0 };
    const entry = (id) => ({ id, organisationId: 'o', agentId: 'a', cycleId: 'c', cost: 1, at: 100 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].reserveSpend(entry(String(i)), limits)));
    assert.equal(results.filter((r) => r.created).length, 2);
    const accepted = results.findIndex((r) => r.created);
    assert.equal((await stores[1].reserveSpend(entry(String(accepted)), limits)).created, false);
    assert.equal(await db.collection(`${s.governorPrefix}_spend`).countDocuments(), 2);
    const proposal = { organisationId: 'o', id: 'p', status: 'pending_approval', approvals: [] };
    await stores[0].putProposal(proposal);
    const approvals = await Promise.all(stores.map((store, i) => store.transitionProposal('o', 'p', 'pending_approval', { approvals: [{ id: String(i) }] }, { approvals: 0 })));
    assert.equal(approvals.filter(Boolean).length, 1);
    const state = { organisationId: 'o', kind: 'routing', id: 'r', revision: 1, candidate: null };
    await stores[0].createObject(state);
    const updates = await Promise.all(stores.map((store) => store.updateObject('o', 'routing', 'r', 1, { ...state, revision: 2 })));
    assert.equal(updates.filter(Boolean).length, 1);
    const recordStores = [s.store, createMongoConscienceStore(other.db(), { prefix: s.prefix })];
    const envelope = { organisationId: 'o', kind: 'decision', id: 'd', recordedAt: new Date(0).toISOString(), data: { text: '$data' } };
    const records = await Promise.all(Array.from({ length: 12 }, (_, i) => recordStores[i % 2].put({ ...envelope, data: { n: i } })));
    assert.equal(records.filter((r) => r.created).length, 1);
    assert.ok(records.every((r) => r.record.data.n === records[0].record.data.n));
    assert.equal(await db.collection(`${s.prefix}_records`).countDocuments(), 1);
    await s.governorStore.appendAudit({ id: 'audit', organisationId: 'o', at: envelope.recordedAt });
    await assert.rejects(s.governorStore.appendAudit({ id: 'audit', organisationId: 'p', at: envelope.recordedAt }), { code: 11000 });
  } finally { await other.close(); await s.cleanup(); }
});

require('./mongoStorageContract').mongoStorageContract('mongo real storage', fresh, options);

test('mongo real: transaction failure rolls back spend and lock, then permits retry', options, async () => {
  const s = await fresh();
  let fail = true;
  const wrapped = {
    client,
    collection(name) {
      const collection = db.collection(name);
      if (name === `${s.governorPrefix}_spend`) {
        const insert = collection.insertOne.bind(collection);
        collection.insertOne = async (...args) => {
          const result = await insert(...args);
          if (fail) throw new Error('injected write failure');
          return result;
        };
      }
      return collection;
    }
  };
  try {
    const store = createMongoGovernorStore(wrapped, { prefix: s.governorPrefix });
    const entry = { id: 's', organisationId: 'o', agentId: 'a', cycleId: null, cost: 1, at: 0 };
    const limits = { perCycle: 1, perAgent: 1, perOrganisation: 1, since: 0 };
    await assert.rejects(store.reserveSpend(entry, limits), /injected write failure/);
    assert.equal(await db.collection(`${s.governorPrefix}_spend`).countDocuments(), 0);
    assert.equal((await db.collection(`${s.governorPrefix}_locks`).findOne({ _id: 'o' })).revision, 0);
    fail = false;
    assert.equal((await store.reserveSpend(entry, limits)).created, true);
  } finally { await s.cleanup(); }
});

test('mongo real: native stores accept a mongoose connection without models', options, async () => {
  const mongoose = require('mongoose');
  const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const s = await fresh();
  try {
    const store = createMongoConscienceStore(connection.db, { prefix: s.prefix });
    const governor = createMongoGovernorStore(connection.db, { prefix: s.governorPrefix, client: connection.getClient() });
    await store.put({ organisationId: 'o', kind: 'decision', id: 'd', recordedAt: '2026-01-01', data: { text: '$literal' } });
    assert.equal((await s.store.get('decision', 'o', 'd')).data.text, '$literal');
    assert.equal((await governor.reserveSpend({ id: 's', organisationId: 'o', agentId: 'a', cycleId: null, cost: 1, at: 0 }, { perCycle: 1, perAgent: 1, perOrganisation: 1, since: 0 })).created, true);
  } finally { await connection.close(); await s.cleanup(); }
});
