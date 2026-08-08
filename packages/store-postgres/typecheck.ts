import {
  createPostgresSettingsStore,
  createPostgresUsersStore,
  type PostgresSettingsStore,
  type PostgresUsersStore
} from '@astratra/store-postgres';

interface AppUser {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  name?: string;
}

interface AppSettings {
  timezone: string;
  flags: {
    reminders: boolean;
  };
}

const usersStore: PostgresUsersStore<AppUser> = createPostgresUsersStore<AppUser>({
  connectionString: 'postgres://localhost:5432/astratra_typecheck',
  usersTable: 'app_users',
  uniqueEmail: true
});

usersStore.create({ email: 'admin@example.test', role: 'admin', name: 'Admin' });
usersStore.findByEmail('admin@example.test');
usersStore.findById('00000000-0000-0000-0000-000000000000');
usersStore.list({ role: 'member', limit: 10, offset: 0 });
usersStore.update('00000000-0000-0000-0000-000000000000', { name: 'Updated' });
usersStore.disconnect();

const settingsStore: PostgresSettingsStore<AppSettings> = createPostgresSettingsStore<AppSettings>({
  connectionString: 'postgres://localhost:5432/astratra_typecheck',
  settingsTable: 'app_settings'
});

settingsStore.set('timezone', 'Europe/Paris');
settingsStore.set('flags', { reminders: true });
settingsStore.get('timezone');
settingsStore.getAll();
settingsStore.disconnect();
