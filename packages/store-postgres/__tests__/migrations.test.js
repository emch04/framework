const { newDb } = require('pg-mem');
const { createPostgresMigrationRunner } = require('../src');

function createTestPool() {
  const db = newDb();
  db.public.registerFunction({
    name: 'current_database',
    returns: 'text',
    implementation: () => 'astratra_test'
  });
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

let pool;

beforeEach(() => {
  pool = createTestPool();
});

test('applies migrations in order and records them in the ledger', async () => {
  const runner = createPostgresMigrationRunner({ pool });

  const result = await runner.run([
    { id: '001-create-widgets', up: (client) => client.query('CREATE TABLE widgets (id SERIAL PRIMARY KEY, name TEXT)') },
    { id: '002-add-color', up: (client) => client.query('ALTER TABLE widgets ADD COLUMN color TEXT') }
  ]);

  expect(result.applied).toEqual(['001-create-widgets', '002-add-color']);
  expect(await runner.appliedIds()).toEqual(['001-create-widgets', '002-add-color']);

  await pool.query("INSERT INTO widgets (name, color) VALUES ('gizmo', 'blue')");
  const rows = await pool.query('SELECT name, color FROM widgets');
  expect(rows.rows).toEqual([{ name: 'gizmo', color: 'blue' }]);
});

test('running again is a no-op for already-applied migrations', async () => {
  const runner = createPostgresMigrationRunner({ pool });
  const migrations = [
    { id: '001-create-widgets', up: (client) => client.query('CREATE TABLE widgets (id SERIAL PRIMARY KEY)') }
  ];

  await runner.run(migrations);
  const second = await runner.run(migrations);

  expect(second.applied).toEqual([]);
});

test('a new migration appended later only applies the new one', async () => {
  const runner = createPostgresMigrationRunner({ pool });

  await runner.run([
    { id: '001-create-widgets', up: (client) => client.query('CREATE TABLE widgets (id SERIAL PRIMARY KEY)') }
  ]);
  const result = await runner.run([
    { id: '001-create-widgets', up: (client) => client.query('CREATE TABLE widgets (id SERIAL PRIMARY KEY)') },
    { id: '002-add-name', up: (client) => client.query('ALTER TABLE widgets ADD COLUMN name TEXT') }
  ]);

  expect(result.applied).toEqual(['002-add-name']);
});

test('a failing migration is rolled back and not recorded as applied', async () => {
  const runner = createPostgresMigrationRunner({ pool });

  await expect(runner.run([
    { id: '001-broken', up: (client) => client.query('CREATE TABLE this is not valid sql') }
  ])).rejects.toThrow('001-broken');

  expect(await runner.appliedIds()).toEqual([]);
});

test('rejects malformed migration definitions before touching the database', async () => {
  const runner = createPostgresMigrationRunner({ pool });

  await expect(runner.run([{ id: 'no-up-fn' }])).rejects.toThrow(/up\(client\)/);
  await expect(runner.run([{ up: async () => {} }])).rejects.toThrow(/non-empty string id/);
  await expect(runner.run([
    { id: 'dup', up: async () => {} },
    { id: 'dup', up: async () => {} }
  ])).rejects.toThrow(/Duplicate migration id/);
});

test('rejects an invalid custom migrations table name', () => {
  expect(() => createPostgresMigrationRunner({ pool, migrationsTable: 'bad; drop table users;' }))
    .toThrow(/invalid migrationsTable/);
});
