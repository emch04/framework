'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { postgresTaskSchema, createPostgresTaskStore, createAgent } = require('../src');
test('schema validates identifiers and query adapter validates its dependency', () => {
  assert.match(postgresTaskSchema(), /CREATE TABLE IF NOT EXISTS/);
  assert.throws(() => postgresTaskSchema({ table: 'tasks; DROP TABLE other' }));
  assert.throws(() => createPostgresTaskStore({}));
});
const uri = process.env.AGENT_TEST_DATABASE_URL;
let safe = false;
try { const parsed = new URL(uri); safe = ['postgres:', 'postgresql:'].includes(parsed.protocol) && decodeURIComponent(parsed.pathname).endsWith('_test'); } catch (_error) { /* No eligible database supplied. */ }
test('real PostgreSQL task contract and concurrent lock', { skip: !safe && 'AGENT_TEST_DATABASE_URL must name a database ending in _test' }, async () => {
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: uri });
  const table = `tasks_${randomUUID().replaceAll('-', '')}`;
  const store = createPostgresTaskStore(pool, { table });
  try {
    await pool.query(postgresTaskSchema({ table })); await pool.query(postgresTaskSchema({ table }));
    const agent = createAgent({ store, turn: () => ({ text: 'Done' }) });
    const task = await agent.create({ id: "task'quoted", question: 'Work' });
    await assert.rejects(store.create(task)); assert.equal(await store.get('missing'), null);
    const results = await Promise.all([store.acquire(task.id, 'a', 1000), store.acquire(task.id, 'b', 1000)]);
    assert.equal(results.filter(Boolean).length, 1); const owner = results[0] ? 'a' : 'b';
    assert.equal(await store.renew(task.id, 'wrong', 1000), false);
    await assert.rejects(store.save(task, 'wrong'), /lock/);
    assert.equal(await store.renew(task.id, owner, 1000), true);
    task.plan = [{ id: 'a', text: 'Saved', state: 'done' }]; await store.save(task, owner);
    assert.deepEqual((await store.get(task.id)).plan, task.plan);
    await store.release(task.id, 'wrong'); assert.equal(await store.acquire(task.id, 'c', 1000), false);
    await store.release(task.id, owner); assert.equal((await agent.resume(task.id)).state, 'completed');
    assert.equal(await store.acquire('missing', 'c', 1000), false);
    assert.equal(await store.acquire(task.id, 'expired', 1), true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await store.renew(task.id, 'expired', 1000), false);
    assert.equal(await store.acquire(task.id, 'new', 1000), true);
    await assert.rejects(store.save(task, 'expired'), /lock/);
  } finally { await pool.query(`DROP TABLE "${table}"`); await pool.end(); }
});
