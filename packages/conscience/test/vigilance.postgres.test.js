'use strict';
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { postgresConscienceSchema, createPostgresConscienceStore } = require('../src');
const { postgresGovernorSchema, createPostgresGovernorStore } = require('../src/governor');
const { postgresVigilanceSchema, createPostgresVigilanceStore, createFollowUps } = require('../src/autoconscience');
const { vigilanceContract } = require('./vigilanceContract');
const { makeConscience, decisionInput, mask } = require('./helpers');

/* ---- without a database: identifiers are checked, values travel as parameters ---- */

function recorder() {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
}

test('vigilance schema takes a checked prefix only and is idempotent SQL', () => {
  assert.match(postgresVigilanceSchema(), /CREATE TABLE IF NOT EXISTS "astratra_vigilance_follow_ups"/);
  assert.match(postgresVigilanceSchema(), /CREATE TABLE IF NOT EXISTS "astratra_vigilance_candidates"/);
  for (const prefix of ['x; DROP TABLE y', 'a"b', '1abc', 'a'.repeat(60)]) {
    assert.throws(() => postgresVigilanceSchema({ prefix }));
    assert.throws(() => createPostgresVigilanceStore(recorder(), { prefix }));
  }
  assert.throws(() => createPostgresVigilanceStore({}));
});

test('vigilance store: everything a caller controls is a SQL parameter', async () => {
  const hostile = "x'); DROP TABLE users; --";
  const db = recorder();
  const store = createPostgresVigilanceStore(db);
  const followUp = { id: hostile, organisationId: hostile, userId: hostile, agentId: hostile, decisionId: hostile, observableAt: new Date(0).toISOString(), status: hostile, fingerprint: hostile, createdAt: new Date(0).toISOString(), question: hostile };
  await store.putFollowUp(followUp);
  await store.getFollowUp(hostile, hostile);
  await store.listFollowUps({ organisationId: hostile, userId: hostile, decisionId: hostile, status: hostile, observableTo: hostile });
  await store.listFollowUps({ organisationId: hostile, userId: null });
  await store.updateFollowUp(hostile, hostile, hostile, { status: hostile });
  await store.removeFollowUps({ organisationId: hostile, userId: hostile });
  await store.putCandidate({ id: hostile, organisationId: hostile, agentId: hostile, proposalId: hostile, fingerprint: hostile, createdAt: new Date(0).toISOString() });
  await store.getCandidate(hostile, hostile);
  await store.listCandidates({ organisationId: hostile, agentId: hostile });
  assert.ok(db.calls.length >= 9);
  for (const call of db.calls) assert.doesNotMatch(call.sql, /DROP TABLE users/);
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
  try { await getPool().query('SELECT 1'); } catch (_error) { unavailable = 'PostgreSQL test database unavailable'; }
});

async function freshStores() {
  if (unavailable) return { unavailable };
  const db = getPool();
  const prefix = `c_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const governorPrefix = `g_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const vigilancePrefix = `v_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await db.query(postgresConscienceSchema({ prefix }));
  await db.query(postgresGovernorSchema({ prefix: governorPrefix }));
  await db.query(postgresVigilanceSchema({ prefix: vigilancePrefix }));
  await db.query(postgresVigilanceSchema({ prefix: vigilancePrefix }));
  return {
    prefix, vigilancePrefix,
    store: createPostgresConscienceStore(db, { prefix }),
    governorStore: createPostgresGovernorStore(db, { prefix: governorPrefix }),
    vigilanceStore: createPostgresVigilanceStore(db, { prefix: vigilancePrefix }),
    async cleanup() {
      await db.query(`DROP TABLE IF EXISTS "${prefix}_records"`);
      for (const table of ['proposals', 'audit', 'spend', 'controls', 'objects', 'versions', 'findings']) await db.query(`DROP TABLE IF EXISTS "${governorPrefix}_${table}"`);
      for (const table of ['follow_ups', 'candidates']) await db.query(`DROP TABLE IF EXISTS "${vigilancePrefix}_${table}"`);
    }
  };
}

vigilanceContract('postgres', freshStores, { skip });

test('postgres vigilance: concurrent identical follow-ups give one row', { skip }, async (t) => {
  const stores = await freshStores();
  if (stores.unavailable) { t.skip(stores.unavailable); return; }
  try {
    const { conscience, governor, clock } = makeConscience(stores);
    await conscience.recordDecision(decisionInput({ id: 'd1' }));
    const followUps = createFollowUps({ governor, conscience, store: stores.vigilanceStore, masker: mask, now: clock });
    const input = { organisationId: 'org-a', decisionId: 'd1', observableAt: '2026-10-05T00:00:00Z', question: 'Look again.' };
    const results = await Promise.all(Array.from({ length: 6 }, () => followUps.scheduleFollowUp(input)));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.followUp.id)).size, 1);
    const count = (await getPool().query(`SELECT count(*)::int AS n FROM "${stores.vigilancePrefix}_follow_ups"`)).rows[0].n;
    assert.equal(count, 1);
    // Two completions race: one wins.
    const done = await Promise.all([1, 2, 3].map(() => followUps.completeFollowUp({ organisationId: 'org-a', id: results[0].followUp.id })));
    assert.equal(done.filter((d) => d.completed).length, 1);
  } finally { await stores.cleanup(); }
});
