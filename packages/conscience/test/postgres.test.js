'use strict';
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { postgresConscienceSchema, createPostgresConscienceStore } = require('../src');
const { postgresGovernorSchema, createPostgresGovernorStore } = require('../src/governor');
const { governorContract } = require('./governorContract');
const { conscienceContract } = require('./conscienceContract');

/* ---- without a database: identifiers are checked, values travel as parameters ---- */

function recorder() {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
}

test('schemas take a checked prefix only and are idempotent SQL', () => {
  assert.match(postgresConscienceSchema(), /CREATE TABLE IF NOT EXISTS "astratra_conscience_records"/);
  assert.match(postgresGovernorSchema(), /CREATE TABLE IF NOT EXISTS "astratra_governor_proposals"/);
  for (const prefix of ['x; DROP TABLE y', 'a"b', '1abc', 'a'.repeat(60)]) {
    assert.throws(() => postgresConscienceSchema({ prefix }));
    assert.throws(() => postgresGovernorSchema({ prefix }));
    assert.throws(() => createPostgresConscienceStore(recorder(), { prefix }));
  }
  assert.throws(() => createPostgresConscienceStore({}));
  assert.throws(() => createPostgresGovernorStore(null));
});

test('everything a caller controls is a SQL parameter, never part of the SQL text', async () => {
  const hostile = "x'); DROP TABLE users; --";
  const db = recorder();
  const store = createPostgresConscienceStore(db);
  const envelope = { kind: 'decision', id: hostile, organisationId: hostile, userId: hostile, agentId: hostile, decisionId: hostile, lessonId: hostile, eventAt: null, recordedAt: new Date(0).toISOString(), fingerprint: hostile, evidenceRefs: [hostile], data: { text: hostile } };
  await store.put(envelope);
  await store.get('decision', hostile, hostile);
  await store.list('decision', { organisationId: hostile, userId: hostile, agentId: hostile, decisionId: hostile, lessonId: hostile, decisionIds: [hostile], evidenceRef: hostile, eventFrom: hostile, eventTo: hostile, recordedTo: hostile });
  await store.replace(envelope);
  await store.remove('decision', hostile, [hostile]);
  const governorDb = recorder();
  const governorStore = createPostgresGovernorStore(governorDb);
  await governorStore.getProposal(hostile, hostile);
  await governorStore.listProposals({ organisationId: hostile, status: hostile });
  await governorStore.listAudit({ organisationId: hostile, proposalId: hostile });
  await governorStore.getControl(hostile);
  await governorStore.setControl(hostile, { v: hostile });
  for (const call of [...db.calls, ...governorDb.calls]) assert.doesNotMatch(call.sql, /DROP TABLE users/);
  assert.ok(db.calls.length >= 6 && governorDb.calls.length >= 5);
});

/* ---- real PostgreSQL: CONSCIENCE_TEST_DATABASE_URL must name a database ending in _test ---- */

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
  try { await getPool().query('SELECT 1'); } catch (error) {
    if (error.code === '3D000') {
      const parsed = new URL(uri);
      const { spawnSync } = require('node:child_process');
      const args = ['--maintenance-db=postgres'];
      if (parsed.hostname) args.push('--host', parsed.hostname);
      if (parsed.port) args.push('--port', parsed.port);
      if (parsed.username) args.push('--username', decodeURIComponent(parsed.username));
      args.push(decodeURIComponent(parsed.pathname.slice(1)));
      spawnSync('createdb', args, { env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) }, stdio: 'ignore', timeout: 5000 });
      try { await getPool().query('SELECT 1'); return; } catch (_error) { /* Unavailable test infrastructure. */ }
    }
    unavailable = 'PostgreSQL test database unavailable; creation or connection not permitted';
  }
});

async function freshStores() {
  if (unavailable) return { unavailable };
  const db = getPool();
  const prefix = `c_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const governorPrefix = `g_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await db.query(postgresConscienceSchema({ prefix }));
  await db.query(postgresConscienceSchema({ prefix }));
  await db.query(postgresGovernorSchema({ prefix: governorPrefix }));
  await db.query(postgresGovernorSchema({ prefix: governorPrefix }));
  return {
    prefix,
    store: createPostgresConscienceStore(db, { prefix }),
    governorStore: createPostgresGovernorStore(db, { prefix: governorPrefix }),
    async cleanup() {
      await db.query(`DROP TABLE IF EXISTS "${prefix}_records"`);
      for (const table of ['proposals', 'audit', 'spend', 'controls']) await db.query(`DROP TABLE IF EXISTS "${governorPrefix}_${table}"`);
    }
  };
}

governorContract('postgres', async () => { const stores = await freshStores(); return { store: stores.governorStore, cleanup: stores.cleanup, unavailable: stores.unavailable }; }, { skip });
conscienceContract('postgres', freshStores, { skip });

test('postgres: concurrent identical records give one row', { skip }, async (t) => {
  const stores = await freshStores();
  if (stores.unavailable) { t.skip(stores.unavailable); return; }
  try {
    const { makeConscience, decisionInput } = require('./helpers');
    const { conscience } = makeConscience(stores);
    const results = await Promise.all(Array.from({ length: 6 }, () => conscience.recordDecision(decisionInput())));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.decision.id)).size, 1);
    const count = (await getPool().query(`SELECT count(*)::int AS n FROM "${stores.prefix}_records"`)).rows[0].n;
    assert.equal(count, 1);
  } finally { await stores.cleanup(); }
});

const { evaluationContract } = require('./evaluationContract');
evaluationContract('postgres', freshStores, { skip });
