'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMongoConscienceStore, mongoConscienceIndexes } = require('../src');
const { createMongoGovernorStore, mongoGovernorIndexes } = require('../src/governor');
const { fakeDatabase } = require('./mongoFake');
const { governorContract } = require('./governorContract');
const { advancedContract } = require('./advancedContract');
const { conscienceContract } = require('./conscienceContract');
const { evaluationContract } = require('./evaluationContract');
async function fresh() {
  const db = fakeDatabase();
  await mongoGovernorIndexes(db); await mongoConscienceIndexes(db);
  return { db, store: createMongoConscienceStore(db), governorStore: createMongoGovernorStore(db) };
}
governorContract('mongo fake', async () => ({ store: (await fresh()).governorStore }));
advancedContract('mongo fake', async () => ({ store: (await fresh()).governorStore }));
conscienceContract('mongo fake', fresh);
evaluationContract('mongo fake', fresh);

test('mongo: checked prefixes, native Db and session client are required', async () => {
  for (const prefix of ['a.b', '$bad', '1bad', 'a'.repeat(42)]) {
    assert.throws(() => createMongoConscienceStore(fakeDatabase(), { prefix }));
    assert.throws(() => createMongoGovernorStore(fakeDatabase(), { prefix }));
    await assert.rejects(mongoGovernorIndexes(fakeDatabase(), { prefix }));
    await assert.rejects(mongoConscienceIndexes(fakeDatabase(), { prefix }));
  }
  assert.throws(() => createMongoConscienceStore({}));
  assert.throws(() => createMongoGovernorStore({ collection() {} }));
});

test('mongo: concurrent budget reservations, replay and time windows', async () => {
  const { governorStore: store } = await fresh();
  const limits = { perCycle: 2, perAgent: 3, perOrganisation: 4, since: 100 };
  const entry = (id, extra = {}) => ({ id, organisationId: 'o', agentId: 'a', cycleId: 'c', cost: 1, at: 100, ...extra });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.reserveSpend(entry(String(i)), limits)));
  assert.equal(results.filter((r) => r.created).length, 2);
  const replay = await store.reserveSpend(entry('0', { cost: 100 }), limits);
  assert.deepEqual(replay, { reserved: true, created: false, totals: { cycle: 2, agent: 2, organisation: 2 } });
  assert.equal((await store.reserveSpend(entry('new', { cycleId: null }), limits)).created, true);
  assert.equal((await store.reserveSpend(entry('agent-limit', { cycleId: null }), limits)).reserved, false);
  assert.equal((await store.reserveSpend(entry('other-agent', { agentId: 'b', cycleId: null }), limits)).created, true);
  assert.equal((await store.reserveSpend(entry('org-limit', { agentId: 'b', cycleId: null }), limits)).reserved, false);
  assert.equal((await store.reserveSpend(entry('later', { cycleId: 'later', at: 200 }), { ...limits, since: 200 })).created, true);
  assert.equal((await store.reserveSpend(entry('same-cycle', { at: 200 }), { ...limits, since: 200 })).reserved, false);
  assert.equal((await store.reserveSpend(entry('other-org', { organisationId: 'p' }), limits)).created, true);
  await assert.rejects(store.reserveSpend(entry('negative', { cost: -1 }), limits));
});

test('mongo: literal payloads, atomic approval count and revision guards', async () => {
  const { governorStore: store } = await fresh();
  const proposal = { organisationId: 'o', id: 'p', status: 'pending_approval', approvals: [], text: '$data' };
  await store.putProposal(proposal);
  const results = await Promise.all([1, 2].map((n) => store.transitionProposal('o', 'p', 'pending_approval', { approvals: [{ id: String(n) }], text: '$other' }, { approvals: 0 })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.getProposal('o', 'p')).text, '$other');
  const state = { organisationId: 'o', kind: 'routing', id: 'r', revision: 1, candidate: null };
  await store.createObject(state);
  const revisions = await Promise.all([1, 2].map(() => store.updateObject('o', 'routing', 'r', 1, { ...state, revision: 2 })));
  assert.equal(revisions.filter(Boolean).length, 1);
  assert.equal(await store.updateObject('p', 'routing', 'r', 2, state), null);
});

test('mongo: storage errors propagate and failed reservations roll back', async () => {
  const { db, governorStore: store } = await fresh();
  const table = db.collection('astratra_governor_spend');
  const original = table.insertOne;
  table.insertOne = async function(row, options) { await original.call(this, row, options); throw new Error('write failure'); };
  const entry = { id: 's', organisationId: 'o', agentId: 'a', cycleId: null, cost: 1, at: 0 };
  const limits = { perCycle: 1, perAgent: 1, perOrganisation: 1, since: 0 };
  await assert.rejects(store.reserveSpend(entry, limits), /write failure/);
  assert.equal(table.rows.length, 0);
  assert.equal((await db.collection('astratra_governor_locks').findOne({ _id: 'o' })).revision, 0);
  table.insertOne = original;
  assert.equal((await store.reserveSpend(entry, limits)).created, true);
  const proposals = db.collection('astratra_governor_proposals');
  proposals.insertOne = async () => { throw new Error('unavailable'); };
  await assert.rejects(store.putProposal({ organisationId: 'o', id: 'p' }), /unavailable/);
  proposals.insertOne = async () => { throw Object.assign(new Error('duplicate without row'), { code: 11000 }); };
  await assert.rejects(store.putProposal({ organisationId: 'o', id: 'p' }), /duplicate without row/);
});

test('mongo: explicit migrations and prefixes isolate stores; optional driver stays unloaded', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const script = `require(${JSON.stringify(path.resolve(__dirname, '../src'))});
    require(${JSON.stringify(path.resolve(__dirname, '../src/governor'))});
    process.stdout.write(String(Object.keys(require.cache).some((f) => f.includes('/node_modules/mongodb/'))));`;
  assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'false');
  const db = fakeDatabase();
  const store = createMongoConscienceStore(db, { prefix: 'custom' });
  const e = { organisationId: 'o', kind: 'decision', id: 'x', recordedAt: '2026-01-01', data: {} };
  await store.put(e);
  assert.equal(db.collection('custom_records').indexes.length, 0);
  assert.equal(await createMongoConscienceStore(db).get('decision', 'o', 'x'), null);
  await mongoConscienceIndexes(db, { prefix: 'custom' });
  assert.equal(db.collection('custom_records').indexes.length, 6);
  assert.equal((await store.get('decision', 'o', 'x')).id, 'x');
});

require('./mongoStorageContract').mongoStorageContract('mongo fake storage', fresh);
