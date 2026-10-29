'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMongoConnector, createMongoGovernanceStore, mongoGovernanceIndexes } = require('../src/mongo');
const { makeGovernance, proposalInput } = require('./helpers');

/*
 * Vrai MongoDB : MONGO_TEST_URL (un jeu de réplicas), sinon un jeu de réplicas en mémoire (mongodb-memory-server,
 * binaire déjà en cache). Un serveur seul, sans transactions, sert aux cas « transactions: false ».
 */
let mongodb;
let replSet;
let seul;
let client;
let clientSeul;
let disponible = true;
try { mongodb = require('mongodb'); require('mongodb-memory-server'); } catch (_error) { disponible = false; }
const skip = !disponible && 'pilote mongodb ou mongodb-memory-server absent';

const ids = { p1: '65a000000000000000000001', p2: '65a000000000000000000002', p3: '65a000000000000000000003', p4: '65a000000000000000000004' };
const RESOURCES = {
  products: { table: 'products', key: '_id', writable: ['price', 'stock', 'label', 'soldAt'], filterable: ['category', 'promo'], tags: ['catalogue'],
    amount: 'price', operations: ['update', 'insert', 'delete'], types: { _id: 'objectId', soldAt: 'date' } },
  customers: { table: 'customers', key: '_id', writable: ['email'], sensitive: ['email'], types: { _id: 'objectId' } }
};
let db;
let n = 0;

async function reset(base) {
  await base.dropDatabase();
  await base.createCollection('products', { validator: { $jsonSchema: { properties: { price: { bsonType: ['int', 'double', 'long'], maximum: 10000 } } } } });
  const { ObjectId } = mongodb;
  await base.collection('products').insertMany([
    { _id: new ObjectId(ids.p1), label: 'Tasse', price: 1000, stock: 5, promo: false, category: 'kitchen', soldAt: new Date('2026-11-01T10:00:00Z') },
    { _id: new ObjectId(ids.p2), label: 'Théière', price: 3000, stock: 2, promo: true, category: 'kitchen', soldAt: null },
    { _id: new ObjectId(ids.p3), label: 'Plateau', price: 2000, stock: 9, promo: false, category: 'kitchen', soldAt: null },
    { _id: new ObjectId(ids.p4), label: 'Lampe', price: 4500, stock: 1, promo: false, category: 'light', soldAt: null }
  ]);
  await base.collection('customers').insertOne({ _id: new ObjectId(), email: 'un@example.com' });
  await mongoGovernanceIndexes(base);
}

function makeMongo(options = {}) {
  const { base = db, cli = client, transactions = true, ...rest } = options;
  return makeGovernance({
    connector: createMongoConnector({ db: base, client: cli, resources: RESOURCES, ObjectId: mongodb.ObjectId, transactions }),
    store: createMongoGovernanceStore(base),
    ...rest
  });
}
const doc = (id, base = db) => base.collection('products').findOne({ _id: new mongodb.ObjectId(id) });
const kitchen = (extra = {}) => proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { promo: false, category: 'kitchen' }, set: { price: { multiply: 1.05, round: 0 } } }], ...extra });
const one = (id, set) => proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { _id: id }, set }] });

test.describe('MongoDB', { skip }, () => {
  test.before(async () => {
    const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server');
    const url = process.env.MONGO_TEST_URL;
    if (!url) replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    client = await mongodb.MongoClient.connect(url ?? replSet.getUri());
    seul = await MongoMemoryServer.create();
    clientSeul = await mongodb.MongoClient.connect(seul.getUri());
  });
  test.after(async () => { await client?.close(); await clientSeul?.close(); await replSet?.stop(); await seul?.stop(); });
  test.beforeEach(async () => { db = client.db(`gouvernance_test_${++n}`); await reset(db); });

  test('aperçu en JSON (ObjectId en hexadécimal, date en ISO), validation, écriture et état dans la même transaction', async () => {
    const { governance, validate, store } = makeMongo();
    const out = await governance.propose(kitchen());
    assert.equal(out.status, 'awaiting_validation');
    assert.deepEqual(out.proposal.preview.rows.map((r) => [r.key._id, r.before.price, r.after.price]), [[ids.p1, 1000, 1050], [ids.p3, 2000, 2100]]);
    const done = await governance.applyValidation(validate(out.proposal), { organisationId: 'org-a' });
    assert.equal(done.status, 'executed');
    assert.equal((await doc(ids.p1)).price, 1050);
    assert.equal((await doc(ids.p3)).price, 2100);
    assert.equal((await doc(ids.p2)).price, 3000);
    assert.ok((await doc(ids.p1))._id instanceof mongodb.ObjectId, 'la clé reste un ObjectId');
    assert.equal((await store.get('org-a', out.proposal.id)).status, 'executed');
  });

  test('une date se modifie et reste une date', async () => {
    const { governance, validate } = makeMongo();
    const out = await governance.propose(one(ids.p3, { soldAt: '2026-11-04T09:30:00.000Z' }));
    assert.equal(out.proposal.preview.rows[0].before.soldAt, null);
    await governance.applyValidation(validate(out.proposal), { organisationId: 'org-a' });
    const d = await doc(ids.p3);
    assert.ok(d.soldAt instanceof Date);
    assert.equal(d.soldAt.toISOString(), '2026-11-04T09:30:00.000Z');
  });

  test('une donnée changée, une ligne apparue : rien n\'est écrit', async () => {
    const { governance, validate, store } = makeMongo();
    const a = await governance.propose(kitchen());
    await db.collection('products').updateOne({ _id: new mongodb.ObjectId(ids.p3) }, { $set: { stock: 0 } });
    const r = await governance.applyValidation(validate(a.proposal), { organisationId: 'org-a' });
    assert.equal(r.code, 'stale_data');
    assert.equal((await doc(ids.p1)).price, 1000);
    assert.equal((await store.get('org-a', a.proposal.id)).status, 'stale');

    const b = await governance.propose(one(ids.p4, { stock: 3 }));
    const c = await governance.propose(kitchen({ intent: { code: 'again' } }));
    await db.collection('products').insertOne({ _id: new mongodb.ObjectId(), label: 'Bol', price: 800, stock: 1, promo: false, category: 'kitchen' });
    const r2 = await governance.applyValidation(validate(c.proposal), { organisationId: 'org-a' });
    assert.equal(r2.result.detail.reason, 'appeared');
    assert.equal((await governance.applyValidation(validate(b.proposal), { organisationId: 'org-a' })).status, 'executed');
  });

  test('tout ou rien : le validateur de la collection refuse la deuxième écriture, la première est annulée', async () => {
    const { governance, validate, store } = makeMongo();
    const out = await governance.propose(proposalInput({ actions: [
      { connector: 'shop', resource: 'products', op: 'update', where: { _id: ids.p1 }, set: { price: 1100 } },
      { connector: 'shop', resource: 'products', op: 'update', where: { _id: ids.p3 }, set: { price: 20000 } }
    ] }));
    const r = await governance.applyValidation(validate(out.proposal), { organisationId: 'org-a' });
    assert.equal(r.status, 'failed');
    assert.equal((await doc(ids.p1)).price, 1000);
    assert.equal((await store.get('org-a', out.proposal.id)).status, 'failed');
  });

  test('trois applications simultanées de la même validation : une seule écrit', async () => {
    const { governance, validate } = makeMongo();
    const out = await governance.propose(one(ids.p4, { stock: { increment: 1 } }));
    const v = validate(out.proposal);
    const results = await Promise.all([1, 2, 3].map(() => governance.applyValidation(v, { organisationId: 'org-a' })));
    assert.equal(results.filter((r) => r.status === 'executed' && r.code === null).length, 1);
    assert.equal((await doc(ids.p4)).stock, 2);
  });

  test('libre avec avis : exécuté, puis annulé par un humain', async () => {
    const { governance } = makeMongo({ rules: [{ id: 'notice', level: 'free_with_notice', match: { resources: ['products'] } }] });
    const out = await governance.propose(kitchen());
    assert.equal(out.status, 'executed');
    assert.equal((await governance.undo(out.proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'owner' } })).status, 'undone');
    assert.equal((await doc(ids.p1)).price, 1000);
    assert.equal((await doc(ids.p3)).price, 2000);
  });

  test('ajout avec un ObjectId, suppression ; une valeur sensible masquée reste lisible dans le magasin', async () => {
    const { governance, validate, store } = makeMongo();
    const nouveau = '65a0000000000000000000aa';
    const add = await governance.propose(proposalInput({ intent: { code: 'add' }, actions: [{ connector: 'shop', resource: 'products', op: 'insert', values: { _id: nouveau, label: 'Vase', price: 1500, stock: 4 } }] }));
    assert.equal((await governance.applyValidation(validate(add.proposal), { organisationId: 'org-a' })).status, 'executed');
    assert.ok(await doc(nouveau));
    const del = await governance.propose(proposalInput({ intent: { code: 'remove' }, actions: [{ connector: 'shop', resource: 'products', op: 'delete', where: { _id: nouveau } }] }));
    assert.equal((await governance.applyValidation(validate(del.proposal), { organisationId: 'org-a' })).status, 'executed');
    assert.equal(await doc(nouveau), null);
    const client1 = (await db.collection('customers').findOne({}))._id.toHexString();
    const mail = await governance.propose(proposalInput({ intent: { code: 'fix_email' }, actions: [{ connector: 'shop', resource: 'customers', op: 'update', where: { _id: client1 }, set: { email: 'deux@example.com' } }] }));
    assert.ok(mail.proposal.preview.rows[0].before.email.$masked);
    assert.ok((await store.get('org-a', mail.proposal.id)).proposal.preview.rows[0].before.email.$masked, 'aucun champ « $… » ne devient une clé de document');
  });

  test('les filtres ne laissent passer ni opérateur ni identifiant mal formé', async () => {
    const { governance } = makeMongo();
    await assert.rejects(governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { category: { $ne: 'x' } }, set: { stock: 0 } }] })), { code: 'invalid_action' });
    await assert.rejects(governance.propose(one('pas-un-objectid', { stock: 0 })), { code: 'invalid_action' });
    const out = await governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { category: { in: ['light', "kitchen' || '1'=='1"] } }, set: { stock: 0 } }] }));
    assert.deepEqual(out.proposal.preview.rows.map((r) => r.key._id), [ids.p4]);
  });

  test('serveur seul : les transactions sont refusées, rien n\'est écrit', async () => {
    const base = clientSeul.db(`gouvernance_seul_${++n}`);
    await reset(base);
    const { governance, validate, shop } = makeMongo({ base, cli: clientSeul });
    assert.equal(await shop.check(), false);
    const out = await governance.propose(kitchen());
    const r = await governance.applyValidation(validate(out.proposal), { organisationId: 'org-a' });
    assert.equal(r.status, 'failed');
    assert.equal((await doc(ids.p1, base)).price, 1000);
  });

  test('serveur seul, transactions: false : une écriture, revérifiée par toute la ligne ; plusieurs : refusé', async () => {
    const base = clientSeul.db(`gouvernance_seul_${++n}`);
    await reset(base);
    const { governance, validate } = makeMongo({ base, cli: null, transactions: false });
    const a = await governance.propose(one(ids.p1, { price: 1200 }));
    assert.equal((await governance.applyValidation(validate(a.proposal), { organisationId: 'org-a' })).status, 'executed');
    assert.equal((await doc(ids.p1, base)).price, 1200);
    const b = await governance.propose(one(ids.p3, { price: 2500 }));
    await base.collection('products').updateOne({ _id: new mongodb.ObjectId(ids.p3) }, { $set: { label: 'Plateau bois' } });
    assert.equal((await governance.applyValidation(validate(b.proposal), { organisationId: 'org-a' })).code, 'stale_data');
    assert.equal((await doc(ids.p3, base)).price, 2000);
    const c = await governance.propose(kitchen({ intent: { code: 'two' } }));
    assert.equal((await governance.applyValidation(validate(c.proposal), { organisationId: 'org-a' })).status, 'failed');
    assert.equal((await doc(ids.p1, base)).price, 1200);
  });

  test('le magasin refuse une autre proposition sous le même identifiant', async () => {
    const store = createMongoGovernanceStore(db);
    const record = { organisationId: 'org-a', id: 'x', digest: 'd1', status: 'ready', idempotencyKey: null, createdAt: '2026-11-03T09:00:00Z', expiresAt: '2026-11-03T21:00:00Z', updatedAt: '2026-11-03T09:00:00Z' };
    assert.equal((await store.put(record)).created, true);
    assert.equal((await store.put(record)).created, false);
    await assert.rejects(store.put({ ...record, digest: 'd2' }), { code: 'proposal_conflict' });
  });

  test('connecteur : ObjectId exigé pour une colonne objectId, client exigé pour les transactions', () => {
    assert.throws(() => createMongoConnector({ db, client, resources: RESOURCES }), { code: 'connector_invalid' });
    assert.throws(() => createMongoConnector({ db, resources: RESOURCES, ObjectId: mongodb.ObjectId }), { code: 'connector_invalid' });
  });
});
