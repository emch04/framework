const { randomUUID } = require('node:crypto');
const { createMemoryEventLog, createPostgresEventLog, postgresEventLogSchema } = require('../src');
const { runEventLogContract } = require('./eventLogContract');

describe('PostgreSQL event log: without a database', () => {
  test('the schema quotes the table and refuses an unsafe name', () => {
    expect(postgresEventLogSchema()).toMatch(/CREATE TABLE IF NOT EXISTS "webhook_events"/);
    expect(postgresEventLogSchema({ table: 'shop.sendcloud_events' })).toMatch(/"shop"\."sendcloud_events"/);
    expect(() => postgresEventLogSchema({ table: 'a; DROP TABLE b' })).toThrow(TypeError);
    expect(() => postgresEventLogSchema({ table: 'x"y' })).toThrow(TypeError);
    expect(() => createPostgresEventLog({}, {})).toThrow(/query/);
  });

  test('ids travel as parameters, never inside the SQL text', async () => {
    const calls = [];
    const pool = { query: async (text, params) => { calls.push({ text, params }); return { rows: [{ id: 'x' }], rowCount: 1 }; } };
    const log = createPostgresEventLog(pool);
    await log.claim("evt'; DROP TABLE x; --", { type: 'parcel' });
    expect(calls[0].text).not.toContain('DROP TABLE x');
    expect(calls[0].params[0]).toBe("evt'; DROP TABLE x; --");
    await expect(log.prune(0)).rejects.toThrow(TypeError);
  });
});

runEventLogContract('memory', (options) => createMemoryEventLog(options));

const uri = process.env.PAYMENTS_TEST_DATABASE_URL;
let safe = false;
try {
  const parsed = new URL(uri);
  safe = ['postgres:', 'postgresql:'].includes(parsed.protocol) && decodeURIComponent(parsed.pathname).endsWith('_test');
} catch (_error) { /* No eligible database supplied. */ }

let pool = null;
const tables = [];
if (safe) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: uri, max: 6 });
  afterAll(async () => {
    for (const table of tables) await pool.query(`DROP TABLE IF EXISTS "${table}"`);
    await pool.end();
  });
}

/* Real PostgreSQL only with PAYMENTS_TEST_DATABASE_URL naming a database ending in _test. */
runEventLogContract('postgres', async (options) => {
  const table = `events_${randomUUID().replaceAll('-', '')}`;
  tables.push(table);
  await pool.query(postgresEventLogSchema({ table }));
  return createPostgresEventLog(pool, { table, ...options });
}, { skip: !safe });

(safe ? describe : describe.skip)('postgres: the log is shared and can be pruned', () => {
  test('two logs on the same table (two instances) refuse the same event', async () => {
    const table = `events_${randomUUID().replaceAll('-', '')}`;
    tables.push(table);
    await pool.query(postgresEventLogSchema({ table }));
    const first = createPostgresEventLog(pool, { table });
    const second = createPostgresEventLog(pool, { table });
    const results = await Promise.all([first.claim('evt'), second.claim('evt')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await first.record('evt', { type: 'parcel_status_changed' });
    expect(await second.seen('evt')).toBe(true);
  });

  test('prune deletes old handled events, never a pending claim', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const table = `events_${randomUUID().replaceAll('-', '')}`;
    tables.push(table);
    await pool.query(postgresEventLogSchema({ table }));
    const log = createPostgresEventLog(pool, { table, now: () => now });
    await log.record('old');
    await log.claim('pending');
    now += 100 * 24 * 3600_000;
    expect(await log.prune(90 * 24 * 3600_000)).toBe(1);
    expect(await log.seen('old')).toBe(false);
    expect(await log.claim('pending')).toBe(true);
  });
});
