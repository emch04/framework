const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  createMongoSettingsStore,
  createMongoUsersStore
} = require('../src');

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

test('users store supports CRUD round-trip with plain returned objects', async () => {
  const usersStore = createMongoUsersStore({ connection });

  const created = await usersStore.create({
    email: 'doctor@example.test',
    role: 'doctor',
    name: 'Dr Astratra'
  });

  expect(created).toMatchObject({
    email: 'doctor@example.test',
    role: 'doctor',
    name: 'Dr Astratra'
  });
  expect(created.id).toEqual(expect.any(String));
  expect(created.save).toBeUndefined();

  await expect(usersStore.findByEmail('doctor@example.test')).resolves.toMatchObject({
    id: created.id,
    email: 'doctor@example.test'
  });
  await expect(usersStore.findById(created.id)).resolves.toMatchObject({
    id: created.id,
    role: 'doctor'
  });

  await expect(usersStore.update(created.id, { role: 'admin', name: 'Admin Astratra' })).resolves.toMatchObject({
    id: created.id,
    email: 'doctor@example.test',
    role: 'admin',
    name: 'Admin Astratra'
  });
});

test('users list supports role filtering and pagination', async () => {
  const usersStore = createMongoUsersStore({ connection });
  await usersStore.create({ email: 'admin@example.test', role: 'admin' });
  await usersStore.create({ email: 'doctor-1@example.test', role: 'doctor' });
  await usersStore.create({ email: 'doctor-2@example.test', role: 'doctor' });
  await usersStore.create({ email: 'patient@example.test', role: 'patient' });

  const doctors = await usersStore.list({ role: 'doctor', limit: 1, offset: 1 });

  expect(doctors).toHaveLength(1);
  expect(doctors[0]).toMatchObject({
    email: 'doctor-2@example.test',
    role: 'doctor'
  });
});

test('users store rejects duplicate email when uniqueEmail is enabled', async () => {
  const usersStore = createMongoUsersStore({ connection, uniqueEmail: true });

  await usersStore.create({ email: 'duplicate@example.test', role: 'admin' });

  await expect(usersStore.create({ email: 'duplicate@example.test', role: 'doctor' })).rejects.toMatchObject({
    code: 11000
  });
});

test('settings store supports get, set and getAll', async () => {
  const settingsStore = createMongoSettingsStore({ connection });

  await expect(settingsStore.get('timezone')).resolves.toBeNull();
  await settingsStore.set('timezone', 'Europe/Paris');
  await settingsStore.set('flags', { reminders: true });
  await settingsStore.set('timezone', 'Africa/Kinshasa');

  await expect(settingsStore.get('timezone')).resolves.toBe('Africa/Kinshasa');
  await expect(settingsStore.getAll()).resolves.toEqual({
    timezone: 'Africa/Kinshasa',
    flags: { reminders: true }
  });
});

test('findById and update return null for missing or invalid ids', async () => {
  const usersStore = createMongoUsersStore({ connection });
  const missingId = new mongoose.Types.ObjectId().toString();

  await expect(usersStore.findById(missingId)).resolves.toBeNull();
  await expect(usersStore.update(missingId, { role: 'admin' })).resolves.toBeNull();
  await expect(usersStore.findById('not-a-valid-objectid')).resolves.toBeNull();
  await expect(usersStore.update('not-a-valid-objectid', { role: 'admin' })).resolves.toBeNull();
});

test('stores can manage their own connection when uri is provided', async () => {
  const usersStore = createMongoUsersStore({
    uri: server.getUri(),
    collection: 'managed_users'
  });

  const created = await usersStore.create({ email: 'managed@example.test', role: 'admin' });

  expect(created.id).toEqual(expect.any(String));
  await usersStore.disconnect();
});
