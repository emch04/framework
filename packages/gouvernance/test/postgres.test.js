'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createPostgresGovernorStore, postgresGovernorSchema } = require('@astratra/conscience/governor');
const { createPostgresConnector, createPostgresGovernanceStore, postgresGovernanceSchema } = require('../src/postgres');
const { makeGovernance, proposalInput } = require('./helpers');

/* Vrai PostgreSQL : GOUVERNANCE_TEST_DATABASE_URL doit nommer une base dont le nom finit par _test. */
const uri = process.env.GOUVERNANCE_TEST_DATABASE_URL;
let safe = false;
try { const parsed = new URL(uri); safe = ['postgres:', 'postgresql:'].includes(parsed.protocol) && decodeURIComponent(parsed.pathname).endsWith('_test'); } catch (_error) { /* aucune base permise */ }
const skip = !safe && 'GOUVERNANCE_TEST_DATABASE_URL doit nommer une base dont le nom finit par _test';

let pg;
let pool;

const RESOURCES = {
  products: { table: 'shop.products', key: 'id', writable: ['price', 'stock', 'label'], filterable: ['promo', 'category'], tags: ['catalogue'], amount: 'price', maxRows: 50, operations: ['update', 'insert', 'delete'] },
  lines: { table: 'shop.order_lines', key: ['order_id', 'line'], writable: ['quantity'], operations: ['update'] }
};

async function reset() {
  await pool.query(`
    DROP SCHEMA IF EXISTS shop CASCADE;
    CREATE SCHEMA shop;
    CREATE TABLE shop.products (id text PRIMARY KEY, label text NOT NULL, price numeric(10,2) NOT NULL CHECK (price < 10000), stock integer NOT NULL, promo boolean NOT NULL DEFAULT false, category text, updated_at timestamptz DEFAULT now());
    INSERT INTO shop.products (id, label, price, stock, promo, category) VALUES
      ('p1', 'Tasse', 10.00, 5, false, 'kitchen'), ('p2', 'Théière', 30.00, 2, true, 'kitchen'), ('p3', 'Plateau', 20.00, 9, false, 'kitchen'), ('p4', 'Lampe', 45.00, 1, false, 'light');
    CREATE TABLE shop.order_lines (order_id integer, line integer, quantity integer NOT NULL, PRIMARY KEY (order_id, line));
    INSERT INTO shop.order_lines VALUES (1, 1, 2), (1, 2, 3), (2, 1, 1);
    DROP TABLE IF EXISTS gouvernance_proposals;
    DROP TABLE IF EXISTS test_governor_audit, test_governor_proposals, test_governor_spend, test_governor_controls, test_governor_objects, test_governor_versions, test_governor_findings CASCADE;
  `);
  await pool.query(postgresGovernanceSchema());
  await pool.query(postgresGovernorSchema({ prefix: 'test_governor' }));
}

function makePg(options = {}) {
  const governorStore = createPostgresGovernorStore(pool, { prefix: 'test_governor' });
  return makeGovernance({
    connector: createPostgresConnector({ pool, resources: RESOURCES }),
    store: createPostgresGovernanceStore(pool),
    governorStore,
    ...options
  });
}

const priceOf = async (id) => (await pool.query('SELECT price FROM shop.products WHERE id = $1', [id])).rows[0].price;
const statusOf = async (id) => (await pool.query('SELECT status FROM gouvernance_proposals WHERE id = $1', [id])).rows[0].status;
const shopInput = (overrides = {}) => proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { promo: false, category: 'kitchen' }, set: { price: { multiply: 1.05, round: 2 } } }], ...overrides });

test.describe('PostgreSQL', { skip }, () => {
  test.before(async () => {
    pg = require('pg');
    const parsed = new URL(uri);
    spawnSync('createdb', ['-h', parsed.hostname, ...(parsed.port ? ['-p', parsed.port] : []), ...(parsed.username ? ['-U', decodeURIComponent(parsed.username)] : []), decodeURIComponent(parsed.pathname.slice(1))],
      { env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) }, stdio: 'ignore', timeout: 5000 });
    pool = new pg.Pool({ connectionString: uri, max: 6 });
  });
  test.after(async () => { await pool?.end(); });
  test.beforeEach(reset);

  test('aperçu exact (numeric rendu en texte par pg), validation, écriture et état dans la même transaction', async () => {
    const { governance, validate } = makePg();
    const out = await governance.propose(shopInput());
    assert.equal(out.status, 'awaiting_validation');
    assert.deepEqual(out.proposal.preview.rows.map((r) => [r.key.id, r.before.price, r.after.price]), [['p1', '10.00', 10.5], ['p3', '20.00', 21]]);
    assert.equal(await statusOf(out.proposal.id), 'awaiting_validation');
    const done = await governance.applyValidation(validate(out.proposal), { organisationId: 'org-a' });
    assert.equal(done.status, 'executed');
    assert.equal(await priceOf('p1'), '10.50');
    assert.equal(await priceOf('p3'), '21.00');
    assert.equal(await priceOf('p2'), '30.00');
    assert.equal(await statusOf(out.proposal.id), 'executed');
    const audit = await pool.query("SELECT data->>'action' AS action FROM test_governor_audit WHERE proposal_id = $1 ORDER BY at", [out.proposal.id]);
    assert.ok(audit.rows.some((r) => r.action === 'data_outcome'));
  });

  test('une modification par quelqu\'un d\'autre entre la validation et l\'écriture : rien n\'est écrit', async () => {
    const { governance, validate } = makePg();
    const { proposal } = await governance.propose(shopInput());
    await pool.query("UPDATE shop.products SET stock = 0 WHERE id = 'p3'");
    const out = await governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
    assert.equal(out.code, 'stale_data');
    assert.equal(await priceOf('p1'), '10.00');
    assert.equal(await statusOf(proposal.id), 'stale');
  });

  test('une ligne apparue (fantôme) : rien n\'est écrit', async () => {
    const { governance, validate } = makePg();
    const { proposal } = await governance.propose(shopInput());
    await pool.query("INSERT INTO shop.products (id, label, price, stock, category) VALUES ('p9', 'Bol', 8, 3, 'kitchen')");
    const out = await governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
    assert.equal(out.code, 'stale_data');
    assert.equal(out.result.detail.reason, 'appeared');
    assert.equal(await priceOf('p1'), '10.00');
  });

  test('tout ou rien : une contrainte qui casse à la deuxième ligne annule la première', async () => {
    const { governance, validate } = makePg();
    const { proposal } = await governance.propose(proposalInput({ actions: [
      { connector: 'shop', resource: 'products', op: 'update', where: { id: 'p1' }, set: { price: 11 } },
      { connector: 'shop', resource: 'products', op: 'update', where: { id: 'p3' }, set: { price: 20000 } }
    ] }));
    const out = await governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
    assert.equal(out.status, 'failed');
    assert.equal(out.code, 'execution_failed');
    assert.equal(await priceOf('p1'), '10.00');
    assert.equal(await statusOf(proposal.id), 'failed');
  });

  test('deux applications simultanées de la même validation : une seule écrit', async () => {
    const { governance, validate } = makePg();
    const { proposal } = await governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { id: 'p4' }, set: { stock: { increment: 1 } } }] }));
    const validation = validate(proposal);
    const results = await Promise.all([1, 2, 3].map(() => governance.applyValidation(validation, { organisationId: 'org-a' })));
    assert.equal(results.filter((r) => r.status === 'executed' && r.code === null).length, 1);
    assert.equal((await pool.query("SELECT stock FROM shop.products WHERE id = 'p4'")).rows[0].stock, 2);
  });

  test('écriture concurrente pendant l\'exécution : le verrou et l\'isolation l\'arrêtent proprement', async () => {
    const { governance, validate } = makePg();
    const { proposal } = await governance.propose(shopInput());
    const other = await pool.connect();
    await other.query('BEGIN');
    await other.query("UPDATE shop.products SET stock = 99 WHERE id = 'p1'");
    const pending = governance.applyValidation(validate(proposal), { organisationId: 'org-a' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await other.query('COMMIT');
    other.release();
    const out = await pending;
    assert.equal(out.code, 'stale_data');
    assert.equal(await priceOf('p1'), '10.00');
  });

  test('clé composée, ajout, annulation', async () => {
    const { governance, validate } = makePg({ rules: [{ id: 'notice', level: 'free_with_notice', match: { resources: ['lines'] } }] });
    const out = await governance.propose(proposalInput({ intent: { code: 'fix_quantity' }, actions: [{ connector: 'shop', resource: 'lines', op: 'update', where: { order_id: 1 }, set: { quantity: { increment: 1 } } }] }));
    assert.equal(out.status, 'executed');
    assert.deepEqual((await pool.query('SELECT quantity FROM shop.order_lines WHERE order_id = 1 ORDER BY line')).rows.map((r) => r.quantity), [3, 4]);
    assert.equal((await governance.undo(out.proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'owner' } })).status, 'undone');
    assert.deepEqual((await pool.query('SELECT quantity FROM shop.order_lines WHERE order_id = 1 ORDER BY line')).rows.map((r) => r.quantity), [2, 3]);

    const added = await governance.propose(proposalInput({ intent: { code: 'add_product' }, actions: [{ connector: 'shop', resource: 'products', op: 'insert', values: { id: 'p5', label: 'Vase', price: 15, stock: 4 } }] }));
    assert.equal((await governance.applyValidation(validate(added.proposal), { organisationId: 'org-a' })).status, 'executed');
    assert.equal(await priceOf('p5'), '15.00');
  });

  test('annuler une hausse de prix en numeric : la comparaison tolère « 10.50 » contre 10.5', async () => {
    const { governance } = makePg({ rules: [{ id: 'notice', level: 'free_with_notice', match: { resources: ['products'] } }] });
    const out = await governance.propose(shopInput());
    assert.equal(out.status, 'executed');
    assert.equal((await governance.undo(out.proposal.id, { organisationId: 'org-a', by: { kind: 'human', id: 'owner' } })).status, 'undone');
    assert.equal(await priceOf('p1'), '10.00');
  });

  test('les filtres ne laissent passer aucune injection', async () => {
    const { governance } = makePg();
    await assert.rejects(governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { "category = 'x' OR 1=1 --": 'a' }, set: { stock: 0 } }] })), { code: 'column_not_filterable' });
    const out = await governance.propose(proposalInput({ actions: [{ connector: 'shop', resource: 'products', op: 'update', where: { category: { in: ["kitchen' OR '1'='1", 'light'] } }, set: { stock: 0 } }] }));
    assert.deepEqual(out.proposal.preview.rows.map((r) => r.key.id), ['p4']);
  });

  test('le magasin refuse une autre proposition sous le même identifiant', async () => {
    const { store } = makePg();
    const record = { organisationId: 'org-a', id: 'x', digest: 'd1', status: 'ready', idempotencyKey: null, createdAt: '2026-11-03T09:00:00Z', expiresAt: '2026-11-03T21:00:00Z', updatedAt: '2026-11-03T09:00:00Z' };
    assert.equal((await store.put(record)).created, true);
    assert.equal((await store.put(record)).created, false);
    await assert.rejects(store.put({ ...record, digest: 'd2' }), { code: 'proposal_conflict' });
  });
});
