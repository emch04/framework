'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPostgresLock, createPostgresScheduleStore, postgresScheduleSchema, createPostgresApprovalStore, postgresApprovalSchema, createApprovalQueue, createScheduler, ApprovalRefused } = require('../src');

test('schemas validate identifiers and adapters validate their dependency', () => {
  assert.match(postgresScheduleSchema(), /CREATE TABLE IF NOT EXISTS/);
  assert.match(postgresApprovalSchema({ table: 'my_approvals' }), /"my_approvals"/);
  assert.throws(() => postgresApprovalSchema({ table: 'a; DROP TABLE b' }));
  assert.throws(() => postgresScheduleSchema({ table: 'x"y' }));
  assert.throws(() => createPostgresLock({ query() {} }), /connect/);
  assert.throws(() => createPostgresScheduleStore({}));
  assert.throws(() => createPostgresApprovalStore({}));
});

const uri = process.env.AGENT_TEST_DATABASE_URL;
let safe = false;
try { const parsed = new URL(uri); safe = ['postgres:', 'postgresql:'].includes(parsed.protocol) && decodeURIComponent(parsed.pathname).endsWith('_test'); } catch (_error) { /* No eligible database supplied. */ }
const skip = !safe && 'AGENT_TEST_DATABASE_URL must name a database ending in _test';

test('real PostgreSQL advisory lock is exclusive across connections and released on release()', { skip }, async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: uri, max: 4 });
  try {
    const lock = createPostgresLock(pool, { prefix: `t:${randomUUID()}:` });
    const [a, b] = await Promise.all([lock.acquire('job'), lock.acquire('job')]);
    assert.equal([a, b].filter(Boolean).length, 1);
    const other = await lock.acquire('other'); assert.ok(other); await other.release();
    const held = a ?? b;
    assert.equal(await lock.acquire('job'), null);
    await held.release(); await held.release();
    const again = await lock.acquire('job');
    assert.ok(again);
    await again.release();
  } finally { await pool.end(); }
});

test('real PostgreSQL scheduler state is shared and the scheduler runs a due task once across two schedulers', { skip }, async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: uri, max: 6 });
  const table = `schedule_${randomUUID().replaceAll('-', '')}`;
  try {
    await pool.query(postgresScheduleSchema({ table })); await pool.query(postgresScheduleSchema({ table }));
    const store = createPostgresScheduleStore(pool, { table });
    assert.equal(await store.get('x'), null);
    await store.set('x', { a: 1 }); await store.set('x', { a: 2 });
    assert.deepEqual(await store.get('x'), { a: 2 });
    let t = Date.parse('2026-10-16T05:00:00Z'); const now = () => t; let count = 0;
    const prefix = `t:${randomUUID()}:`;
    const make = () => createScheduler({ now, store, lock: createPostgresLock(pool, { prefix }), tasks: [{ id: 'job', schedule: { type: 'interval', everyMs: 1000 }, run: async () => { count += 1; await new Promise((resolve) => setTimeout(resolve, 50)); return { count }; } }] });
    const a = make(); const b = make();
    await a.tick(); t += 1000;
    const results = (await Promise.all([a.tick(), b.tick()])).flat();
    assert.equal(count, 1); assert.equal(results.filter((r) => r.status === 'ok').length, 1);
    assert.deepEqual((await store.get('job')).lastResult, { count: 1 });
  } finally { await pool.query(`DROP TABLE IF EXISTS "${table}"`); await pool.end(); }
});

test('real PostgreSQL approval store: concurrent approvals run once, refusal returns to pending, expiry', { skip }, async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: uri, max: 8 });
  const table = `approvals_${randomUUID().replaceAll('-', '')}`;
  try {
    await pool.query(postgresApprovalSchema({ table })); await pool.query(postgresApprovalSchema({ table }));
    const store = createPostgresApprovalStore(pool, { table });
    let t = Date.parse('2026-10-16T10:00:00Z'); const now = () => t; let calls = 0; let complete = false;
    const queue = createApprovalQueue({ store, now, executors: { pay: async ({ input, idempotencyKey }) => { if (!complete && input.n === 2) throw new ApprovalRefused('incomplete', { missing: ['iban'] }); calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { paid: input.n, key: idempotencyKey }; } } });
    const one = await queue.propose({ type: 'pay', input: { n: 1 }, requestedBy: "agent'quoted", ttlMs: 60000, meta: { note: 'é' } });
    assert.deepEqual(await queue.get(one.id), one); assert.equal(one.expiresAt, t + 60000); assert.equal(await queue.get('missing'), null);
    const settled = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => queue.approve(one.id, { decider: `o${n}` })));
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1); assert.equal(calls, 1);
    for (const s of settled.filter((x) => x.status === 'rejected')) assert.equal(s.reason.code, 'already_decided');
    const done = await queue.get(one.id);
    assert.equal(done.status, 'approved'); assert.deepEqual(done.result, { paid: 1, key: one.id }); assert.ok(done.executedAt);
    const two = await queue.propose({ type: 'pay', input: { n: 2 }, requestedBy: 'agent' });
    await assert.rejects(queue.approve(two.id, { decider: 'o' }), ApprovalRefused);
    const back = await queue.get(two.id);
    assert.equal(back.status, 'pending'); assert.equal(back.decidedBy, null); assert.equal(back.refusal.reason, 'incomplete'); assert.deepEqual(back.refusal.details, { missing: ['iban'] });
    complete = true; await queue.approve(two.id, { decider: 'o' });
    const three = await queue.propose({ type: 'pay', input: { n: 3 }, requestedBy: 'agent', ttlMs: 1000 });
    const rejected = await queue.propose({ type: 'pay', input: { n: 4 }, requestedBy: 'agent' });
    assert.equal((await queue.reject(rejected.id, { decider: 'o', reason: 'no' })).reason, 'no');
    t += 1000;
    await assert.rejects(queue.approve(three.id, { decider: 'o' }), (e) => e.code === 'expired');
    assert.equal((await queue.get(three.id)).status, 'expired');
    assert.deepEqual((await queue.list({ status: 'approved' })).map((a) => a.input.n).sort(), [1, 2]);
    assert.equal((await queue.list({ limit: 2 })).length, 2);
    assert.equal((await queue.list({ requestedBy: "agent'quoted" })).length, 1);
  } finally { await pool.query(`DROP TABLE IF EXISTS "${table}"`); await pool.end(); }
});

test('mapping options are checked', () => {
  assert.throws(() => createPostgresApprovalStore({ query() {} }, { columns: { color: 'x' } }), /unknown field/);
  assert.throws(() => createPostgresApprovalStore({ query() {} }, { columns: { status: null } }), /cannot be null/);
  assert.throws(() => createPostgresApprovalStore({ query() {} }, { columns: { type: 'a b' } }));
  assert.throws(() => createPostgresApprovalStore({ query() {} }, { statuses: { pending: 'x', approved: 'x' } }), /different word/);
  assert.throws(() => createPostgresApprovalStore({ query() {} }, { statuses: { done: 'x' } }), /only/);
  assert.throws(() => createPostgresApprovalStore({ query() {} }, { scope: { column: 'kind' } }), /scope/);
});

test('real PostgreSQL: an old table gains decision_input, and the corrected input is kept with the decision', { skip }, async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: uri, max: 4 });
  const table = `approvals_${randomUUID().replaceAll('-', '')}`;
  try {
    // The table as 1.2.0 created it, without decision_input.
    await pool.query(postgresApprovalSchema({ table }).replace(/,\s*decision_input jsonb\s*\)/, '\n)').replace(/ALTER TABLE[^;]*;/, ''));
    assert.equal((await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'decision_input'`, [table])).rowCount, 0);
    await pool.query(postgresApprovalSchema({ table }));
    const store = createPostgresApprovalStore(pool, { table });
    const ran = [];
    const queue = createApprovalQueue({ store, executors: { pay: async ({ input, proposedInput }) => { ran.push([input, proposedInput]); return { ok: true }; } } });
    const action = await queue.propose({ type: 'pay', input: { amount: 30 }, requestedBy: 'agent' });
    const { action: done } = await queue.approve(action.id, { decider: 'owner', input: { amount: 25 } });
    assert.deepEqual(ran, [[{ amount: 25 }, { amount: 30 }]]);
    assert.deepEqual(done.decisionInput, { amount: 25 });
    assert.deepEqual((await queue.get(action.id)).input, { amount: 30 });
  } finally { await pool.query(`DROP TABLE IF EXISTS "${table}"`); await pool.end(); }
});

test('real PostgreSQL: the store sits on an existing journal table (own columns, status words, other rows left alone)', { skip }, async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: uri, max: 8 });
  const table = `journal_${randomUUID().replaceAll('-', '')}`;
  try {
    // A journal of every action of an app: some need approval, others ran on their own.
    await pool.query(`CREATE TABLE "${table}" (
      ref text PRIMARY KEY, outil text NOT NULL, entree jsonb NOT NULL, demandeur text NOT NULL,
      statut text NOT NULL, cree_le timestamptz NOT NULL, expire_le timestamptz,
      decide_par text, decide_le timestamptz, execute_le timestamptz, resultat jsonb, motif text,
      entree_validee jsonb, necessite_accord boolean NOT NULL DEFAULT true)`);
    await pool.query(`INSERT INTO "${table}" (ref, outil, entree, demandeur, statut, cree_le, necessite_accord) VALUES ('auto-1', 'lire', '{}', 'agent', 'executee', now(), false)`);
    const store = createPostgresApprovalStore(pool, {
      table,
      columns: { id: 'ref', type: 'outil', input: 'entree', requestedBy: 'demandeur', status: 'statut', createdAt: 'cree_le', expiresAt: 'expire_le', decidedBy: 'decide_par', decidedAt: 'decide_le', executedAt: 'execute_le', result: 'resultat', reason: 'motif', decisionInput: 'entree_validee', meta: null, refusal: null },
      statuses: { pending: 'en_attente', approved: 'approuvee', rejected: 'rejetee', expired: 'expiree' },
      scope: { column: 'necessite_accord', value: true }
    });
    let t = Date.parse('2026-10-16T10:00:00Z'); const now = () => t; let calls = 0;
    const queue = createApprovalQueue({ store, now, executors: { rembourser: async ({ input }) => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { rembourse: input.montant }; } } });
    const one = await queue.propose({ type: 'rembourser', input: { montant: 40 }, requestedBy: 'agent', ttlMs: 60000, meta: { ignore: true } });
    assert.equal(one.status, 'pending'); assert.equal(one.meta, null);
    assert.equal((await pool.query(`SELECT statut FROM "${table}" WHERE ref = $1`, [one.id])).rows[0].statut, 'en_attente');
    const settled = await Promise.allSettled([1, 2, 3, 4].map((n) => queue.approve(one.id, { decider: `p${n}`, input: { montant: 35 } })));
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1); assert.equal(calls, 1);
    const row = (await pool.query(`SELECT statut, entree, entree_validee, resultat FROM "${table}" WHERE ref = $1`, [one.id])).rows[0];
    assert.deepEqual(row, { statut: 'approuvee', entree: { montant: 40 }, entree_validee: { montant: 35 }, resultat: { rembourse: 35 } });
    const two = await queue.propose({ type: 'rembourser', input: { montant: 5 }, requestedBy: 'agent', ttlMs: 1000 });
    const three = await queue.propose({ type: 'rembourser', input: { montant: 6 }, requestedBy: 'agent' });
    assert.equal((await queue.reject(three.id, { decider: 'p', reason: 'non' })).reason, 'non');
    t += 1000;
    assert.equal((await queue.expire()).length, 1);
    assert.equal((await pool.query(`SELECT statut FROM "${table}" WHERE ref = $1`, [two.id])).rows[0].statut, 'expiree');
    // The row that never needed approval is outside the queue: not listed, not readable, not touched.
    assert.deepEqual((await queue.list()).map((a) => a.input.montant).sort(), [35, 40, 5, 6].filter((n) => n !== 35).sort());
    assert.equal(await queue.get('auto-1'), null);
    assert.equal((await pool.query(`SELECT statut FROM "${table}" WHERE ref = 'auto-1'`)).rows[0].statut, 'executee');
    assert.deepEqual((await queue.list({ status: 'approved' })).map((a) => a.id), [one.id]);
  } finally { await pool.query(`DROP TABLE IF EXISTS "${table}"`); await pool.end(); }
});
