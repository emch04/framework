import {
  createMemoryDevicesStore,
  createMemoryPasswordResetStore,
  createMemorySettingsStore,
  createMemoryUsersStore,
  createSaasApp
} from '@astratra/saas-kit';
import type {
  DevicesStore,
  PasswordResetStore,
  RegisteredDevice
} from '@astratra/saas-kit';

const usersStore = createMemoryUsersStore({
  users: [{
    id: 'user-owner',
    email: 'owner@example.test',
    role: 'owner',
    password: 'password'
  }]
});

usersStore.findByEmail('owner@example.test');
usersStore.findById('user-owner');
usersStore.create({ email: 'new@example.test', role: 'member', password: 'secret' });
usersStore.list({ role: 'owner', limit: 10, offset: 0 });
usersStore.update('user-owner', { role: 'admin' });

const settingsStore = createMemorySettingsStore({ theme: { color: 'blue' } });
settingsStore.get('theme');
settingsStore.set('theme', { color: 'green' });
settingsStore.getAll();

const app = createSaasApp({
  jwtSecret: 'secret',
  legacyJwtSecret: 'legacy',
  jwtExpiresIn: '2h',
  usersStore,
  settingsStore,
  notify: async (userId, notification) => ({ userId, notification, sent: true }),
  verifyPassword: async (user, password) => user.password === password,
  verifySession: async (decoded) => Boolean(decoded),
  extractToken: (req) => req.headers?.authorization?.replace('Bearer ', '') ?? null,
  publicUserFields: ['id', 'email', 'role'],
  roles: { adminRoles: ['owner', 'admin'] },
  waf: { patterns: [/select/i], message: { success: false } },
  csp: { reportOnly: true, directives: { 'default-src': ["'self'"] } },
  apiRateLimit: { max: 100 },
  loginRateLimit: { max: 5 },
  webauthnStore: {
    async getCredentialsForUser(_userId: string) { return []; },
    async saveCredential(_userId: string, _credential: unknown) {},
    async getCredentialById(_credentialId: string) { return null; },
    async updateCredentialCounter(_credentialId: string, _counter: number) {},
    async saveChallenge(_userId: string, _challenge: string, _type: 'registration' | 'authentication', _metadata: unknown) {},
    async consumeChallenge(_userId: string, _type: 'registration' | 'authentication') { return null; }
  },
  webauthn: {
    allowedOrigins: 'http://localhost:3000',
    recoveryCodeSecret: 'secret'
  }
});

app.use((_req: unknown, _res: unknown, next: () => void) => next());

/* ───────────────── Devices, resets and refresh ───────────────── */

const devices: DevicesStore = createMemoryDevicesStore();
const resets: PasswordResetStore = createMemoryPasswordResetStore();

const sessionsApp = createSaasApp({
  jwtSecret: 'secret',
  notify: async () => ({ queued: true }),
  verifyPassword: async () => true,
  hashPassword: async (password: string) => `hashed:${password}`,
  devicesStore: devices,
  refreshTokens: { enabled: true, ttlMs: 30 * 24 * 60 * 60 * 1000 },
  passwordReset: {
    store: resets,
    ttlMs: 60 * 60 * 1000,
    send: async ({ token }) => void token
  }
});

async function exerciseSessions(): Promise<void> {
  const device: RegisteredDevice = await devices.upsert({
    installationId: 'inst-1',
    pushToken: 'token',
    platform: 'ios',
    userId: 'u1'
  });
  void [device.installationId, await devices.listForUser('u1'), await resets.find('hash'), sessionsApp];
}

void exerciseSessions;
