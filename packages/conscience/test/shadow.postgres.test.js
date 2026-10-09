'use strict';
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { postgresConscienceSchema, createPostgresConscienceStore } = require('../src');
const { postgresGovernorSchema, createPostgresGovernorStore } = require('../src/governor');
const { postgresShadowSchema, createPostgresShadowStore } = require('../src/autoconscience');
const { shadowContract } = require('./shadowContract');

/* Real PostgreSQL: CONSCIENCE_TEST_DATABASE_URL must name a database ending in _test. */
const uri = process.env.CONSCIENCE_TEST_DATABASE_URL;
let safe = false;
try { const parsed = new URL(uri); safe = ['postgres:', 'postgresql:'].includes(parsed.protocol) && decodeURIComponent(parsed.pathname).endsWith('_test'); } catch (_error) { /* No eligible database supplied. */ }
const skip = !safe && 'CONSCIENCE_TEST_DATABASE_URL must name a database ending in _test';

let pool = null;
const getPool = () => { if (!pool) { const { Pool } = require('pg'); pool = new Pool({ connectionString: uri, max: 10, connectionTimeoutMillis: 5000 }); } return pool; };
after(async () => { if (pool) await pool.end(); });

let unavailable = null;
before(async () => {
  if (!safe) return;
  // An opted-in but unavailable database is a failure, never a successful skip.
  try { await getPool().query('SELECT 1'); } catch (_error) { unavailable = 'PostgreSQL test database unavailable'; }
});

async function freshStores() {
  if (unavailable) throw new Error(unavailable);
  const db = getPool();
  const suffix = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const prefix = `c_${suffix()}`, governorPrefix = `g_${suffix()}`, shadowPrefix = `s_${suffix()}`;
  await db.query(postgresConscienceSchema({ prefix }));
  await db.query(postgresGovernorSchema({ prefix: governorPrefix }));
  await db.query(postgresShadowSchema({ prefix: shadowPrefix }));
  await db.query(postgresShadowSchema({ prefix: shadowPrefix })); // idempotent
  return {
    prefix, shadowPrefix,
    store: createPostgresConscienceStore(db, { prefix }),
    governorStore: createPostgresGovernorStore(db, { prefix: governorPrefix }),
    shadowStore: createPostgresShadowStore(db, { prefix: shadowPrefix }),
    async cleanup() {
      await db.query(`DROP TABLE IF EXISTS "${prefix}_records"`);
      for (const table of ['proposals', 'audit', 'spend', 'controls', 'objects', 'versions', 'findings']) await db.query(`DROP TABLE IF EXISTS "${governorPrefix}_${table}"`);
      await db.query(`DROP TABLE IF EXISTS "${shadowPrefix}_runs"`);
    }
  };
}

shadowContract('postgres', freshStores, { skip });

test('postgres P4 shadow: concurrent identical runs give one row, erasure deletes rows, other organisations keep theirs', { skip }, async () => {
  const stores = await freshStores();
  try {
    const store = stores.shadowStore;
    const run = (extra = {}) => ({ id: 'run-1', shadowId: 's', organisationId: 'org-a', userId: 'user-1', createdAt: '2026-10-01T00:00:00.000Z', payload: { n: 1 }, ...extra });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.putShadowRun(run())));
    assert.equal(results.filter((r) => r.created).length, 1);
    await store.putShadowRun(run({ id: 'run-2' }));
    await store.putShadowRun(run({ id: 'run-1', organisationId: 'org-b' }));
    await store.putShadowRun(run({ id: 'run-3', userId: null }));
    const count = async () => (await getPool().query(`SELECT count(*)::int AS n FROM "${stores.shadowPrefix}_runs"`)).rows[0].n;
    assert.equal(await count(), 4);
    assert.equal((await store.listShadowRuns({ organisationId: 'org-a' })).length, 3);
    assert.equal((await store.listShadowRuns({ organisationId: 'org-a', userId: null })).length, 1);
    assert.equal(await store.getShadowRun('org-b', 'run-2'), null);
    assert.equal(await store.removeShadowRuns({ organisationId: 'org-a', userId: 'user-1' }), 2);
    assert.equal(await count(), 2);
    assert.equal((await store.listShadowRuns({ organisationId: 'org-b' })).length, 1);
    assert.deepEqual((await store.getShadowRun('org-b', 'run-1')).payload, { n: 1 });
  } finally { await stores.cleanup(); }
});
