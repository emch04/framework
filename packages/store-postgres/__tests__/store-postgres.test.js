const { newDb } = require('pg-mem');
const {
  createPostgresSettingsStore,
  createPostgresUsersStore
} = require('../src');

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

test('users store supports CRUD round-trip with plain returned objects', async () => {
  const usersStore = createPostgresUsersStore({ pool });

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

  await expect(usersStore.findByEmail('doctor@example.test')).resolves.toMatchObject({
    id: created.id,
    email: 'doctor@example.test'
  });
  await expect(usersStore.findByEmail('DOCTOR@example.test')).resolves.toMatchObject({
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
  const usersStore = createPostgresUsersStore({ pool });
  await usersStore.create({ email: 'admin@example.test', role: 'admin' });
  await usersStore.create({ email: 'doctor-1@example.test', role: 'doctor' });
  await usersStore.create({ email: 'doctor-2@example.test', role: 'doctor' });
  await usersStore.create({ email: 'patient@example.test', role: 'patient' });

  const doctors = await usersStore.list({ role: 'doctor', limit: 1, offset: 1 });

  expect(doctors).toHaveLength(1);
  expect(doctors[0]).toMatchObject({ role: 'doctor' });
  await expect(usersStore.count()).resolves.toBe(4);
  await expect(usersStore.count({ role: 'doctor' })).resolves.toBe(2);
  await expect(usersStore.countByRole()).resolves.toEqual({
    admin: 1,
    doctor: 2,
    patient: 1
  });
});

test('users store rejects duplicate email when uniqueEmail is enabled', async () => {
  const usersStore = createPostgresUsersStore({ pool, uniqueEmail: true });

  await usersStore.create({ email: 'duplicate@example.test', role: 'admin' });

  await expect(usersStore.create({ email: 'duplicate@example.test', role: 'doctor' })).rejects.toMatchObject({
    code: '23505'
  });
});

test('settings store supports get, set and getAll', async () => {
  const settingsStore = createPostgresSettingsStore({ pool });

  await expect(settingsStore.get('timezone')).resolves.toBeNull();
  await expect(settingsStore.set('timezone', 'Europe/Paris')).resolves.toBe('Europe/Paris');
  await expect(settingsStore.set('flags', { reminders: true })).resolves.toEqual({ reminders: true });
  await expect(settingsStore.set('timezone', 'Africa/Kinshasa')).resolves.toBe('Africa/Kinshasa');

  await expect(settingsStore.get('timezone')).resolves.toBe('Africa/Kinshasa');
  await expect(settingsStore.getAll()).resolves.toEqual({
    timezone: 'Africa/Kinshasa',
    flags: { reminders: true }
  });
});

test('findById and update return null for missing or invalid ids', async () => {
  const usersStore = createPostgresUsersStore({ pool });
  const missingId = '00000000-0000-0000-0000-000000000000';

  await expect(usersStore.findById(missingId)).resolves.toBeNull();
  await expect(usersStore.update(missingId, { role: 'admin' })).resolves.toBeNull();
  await expect(usersStore.findById('not-a-valid-uuid')).resolves.toBeNull();
  await expect(usersStore.update('not-a-valid-uuid', { role: 'admin' })).resolves.toBeNull();
});

test('disconnect only closes a self-managed pool, never a caller-provided one', async () => {
  const usersStore = createPostgresUsersStore({ pool });
  await usersStore.create({ email: 'still-open@example.test', role: 'admin' });

  await usersStore.disconnect();

  await expect(pool.query('SELECT 1')).resolves.toBeDefined();
});
