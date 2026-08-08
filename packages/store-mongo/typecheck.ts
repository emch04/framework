import {
  createMongoSettingsStore,
  createMongoUsersStore,
  type MongoSettingsStore,
  type MongoUsersStore
} from '@astratra/store-mongo';

interface ClinicUser {
  id: string;
  email: string;
  role: 'admin' | 'doctor' | 'patient';
  name?: string;
}

interface ClinicSettings {
  timezone: string;
  flags: {
    reminders: boolean;
  };
}

const usersStore: MongoUsersStore<ClinicUser> = createMongoUsersStore<ClinicUser>({
  uri: 'mongodb://127.0.0.1:27017/astratra_typecheck',
  collection: 'clinic_users',
  uniqueEmail: true
});

usersStore.create({ email: 'admin@example.test', role: 'admin', name: 'Admin' });
usersStore.findByEmail('admin@example.test');
usersStore.findById('64b64c1b2f9e4c99b5c3d001');
usersStore.list({ role: 'doctor', limit: 10, offset: 0 });
usersStore.update('64b64c1b2f9e4c99b5c3d001', { name: 'Updated' });
usersStore.disconnect();

const settingsStore: MongoSettingsStore<ClinicSettings> = createMongoSettingsStore<ClinicSettings>({
  uri: 'mongodb://127.0.0.1:27017/astratra_typecheck',
  collection: 'clinic_settings'
});

settingsStore.set('timezone', 'Europe/Paris');
settingsStore.set('flags', { reminders: true });
settingsStore.get('timezone');
settingsStore.getAll();
settingsStore.disconnect();
