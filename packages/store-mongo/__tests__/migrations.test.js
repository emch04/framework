const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createMongoMigrationRunner } = require('../src');

let server;
let connection;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
});

afterAll(async () => {
  if (server) {
    await server.stop();
  }
});

beforeEach(async () => {
  connection = await mongoose.createConnection(server.getUri()).asPromise();
});

afterEach(async () => {
  if (connection) {
    await connection.dropDatabase();
    await connection.close();
  }
});

test('applies migrations in order and records them in the ledger', async () => {
  const runner = createMongoMigrationRunner({ connection });

  const result = await runner.run([
    { id: '001-seed-widgets', up: (conn) => conn.collection('widgets').insertOne({ name: 'gizmo' }) },
    { id: '002-index-widgets', up: (conn) => conn.collection('widgets').createIndex({ name: 1 }) }
  ]);

  expect(result.applied).toEqual(['001-seed-widgets', '002-index-widgets']);
  expect(await runner.appliedIds()).toEqual(['001-seed-widgets', '002-index-widgets']);

  const widgets = await connection.collection('widgets').find({}).toArray();
  expect(widgets).toHaveLength(1);
  expect(widgets[0]).toMatchObject({ name: 'gizmo' });
});

test('running again is a no-op for already-applied migrations', async () => {
  const runner = createMongoMigrationRunner({ connection });
  const insert = jest.fn((conn) => conn.collection('widgets').insertOne({ name: 'gizmo' }));
  const migrations = [{ id: '001-seed-widgets', up: insert }];

  await runner.run(migrations);
  const second = await runner.run(migrations);

  expect(second.applied).toEqual([]);
  expect(insert).toHaveBeenCalledTimes(1);
  const widgets = await connection.collection('widgets').find({}).toArray();
  expect(widgets).toHaveLength(1);
});

test('a new migration appended later only applies the new one', async () => {
  const runner = createMongoMigrationRunner({ connection });
  const first = { id: '001-seed-widgets', up: (conn) => conn.collection('widgets').insertOne({ name: 'gizmo' }) };
  const second = { id: '002-seed-more', up: (conn) => conn.collection('widgets').insertOne({ name: 'sprocket' }) };

  await runner.run([first]);
  const result = await runner.run([first, second]);

  expect(result.applied).toEqual(['002-seed-more']);
});

test('a failing migration is not recorded as applied', async () => {
  const runner = createMongoMigrationRunner({ connection });

  await expect(runner.run([
    { id: '001-broken', up: () => { throw new Error('boom'); } }
  ])).rejects.toThrow('001-broken');

  expect(await runner.appliedIds()).toEqual([]);
});

test('uses a custom migrations collection name when provided', async () => {
  const runner = createMongoMigrationRunner({ connection, migrationsCollection: 'my_migrations' });

  await runner.run([{ id: '001-x', up: async () => {} }]);

  const docs = await connection.collection('my_migrations').find({}).toArray();
  expect(docs.map((doc) => doc.id)).toEqual(['001-x']);
  const defaultLedger = await connection.collection('astratra_migrations').find({}).toArray();
  expect(defaultLedger).toEqual([]);
});

test('rejects malformed migration definitions', async () => {
  const runner = createMongoMigrationRunner({ connection });

  await expect(runner.run([{ id: 'no-up-fn' }])).rejects.toThrow(/up\(connection\)/);
  await expect(runner.run([{ up: async () => {} }])).rejects.toThrow(/non-empty string id/);
  await expect(runner.run([
    { id: 'dup', up: async () => {} },
    { id: 'dup', up: async () => {} }
  ])).rejects.toThrow(/Duplicate migration id/);
});

test('requires options.connection', () => {
  expect(() => createMongoMigrationRunner({})).toThrow(/requires options.connection/);
});
