import {
  DEFAULT_CODE_TTL_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RESEND_DELAY_MS,
  DEFAULT_WINDOW_MS,
  DISCONNECTED,
  LIVE,
  TEST,
  UNKNOWN,
  assertAdapter,
  createCredentialCatalog,
  createCredentialRotation,
  createCredentialVault,
  createCredentialsRoutes,
  createEnvHydrator,
  createMemoryChallengeStore,
  createMemoryCredentialStore,
  createMongoChallengeStore,
  createMongoCredentialStore,
  createPermissiveGuard,
  createUnlockChallenge,
  createValueGuard,
  maskEmail,
  maskSecret
} from './src';
import type {
  ChallengeStore,
  CredentialRotation,
  RotationCompletion,
  RotationReport,
  NextFunction,
  RequestLike,
  ResponseLike,
  CredentialCatalog,
  CredentialStatus,
  CredentialStore,
  CredentialVault,
  EnvHydrator,
  FieldCipher,
  HydrationResult,
  UnlockChallenge,
  ValueGuard
} from './src';

const catalog: CredentialCatalog = createCredentialCatalog({
  spaces: [
    {
      id: 'ai',
      label: 'AI providers',
      hint: 'Tried in order.',
      keys: [
        { key: 'GROQ_API_KEY', label: 'Groq', help: 'First provider.', where: 'console.groq.com' },
        { key: 'PUBLIC_CLIENT_ID', label: 'Client id', secret: false, placeholder: 'ca_...' }
      ]
    }
  ],
  reservedKeys: ['ENCRYPTION_KEY']
});

const managedKeys: string[] = catalog.keys();
const catalogChecks: boolean[] = [
  catalog.has('GROQ_API_KEY'),
  catalog.isReserved('ENCRYPTION_KEY'),
  catalog.isSecret('PUBLIC_CLIENT_ID')
];

const guard: ValueGuard = createValueGuard({
  keys: ['SECRET_KEY'],
  decidingKey: 'SECRET_KEY',
  livePattern: /^sk_live_/,
  testPattern: /^sk_test_/,
  isProduction: () => process.env.NODE_ENV === 'production'
});
const permissive: ValueGuard = createPermissiveGuard();
const classes: string[] = [LIVE, TEST, UNKNOWN, guard.classify('sk_live_x')];
const mayRead: boolean = guard.mayRead('SECRET_KEY', { value: 'sk_test_x', decidingValue: 'sk_test_x' });
const mayWriteReason: string | undefined = guard.mayWrite('SECRET_KEY', 'sk_live_x').reason;
const restricted: boolean = guard.restrictsHere('SECRET_KEY').ok && permissive.restrictsHere('X').ok;

const store: CredentialStore = createMemoryCredentialStore([
  { key: 'GROQ_API_KEY', value: 'ciphertext', secret: true }
]);
const challengeStore: ChallengeStore = createMemoryChallengeStore();
const mongoStore: CredentialStore = createMongoCredentialStore({
  collection: {},
  isReady: () => true,
  maxTimeMS: 3000
});
const mongoChallengeStore: ChallengeStore = createMongoChallengeStore({ collection: {} });

const cipher: FieldCipher = {
  encrypt: (plaintext: string) => plaintext,
  decrypt: (payload: string) => payload
};

const vault: CredentialVault = createCredentialVault({
  store,
  catalog,
  cipher,
  guard,
  env: process.env,
  cacheMs: 60_000,
  now: () => Date.now(),
  logger: { warn: () => {}, error: () => {} },
  onChange: async (event) => void event.key
});

const hydrator: EnvHydrator = createEnvHydrator({ vault, guard, env: process.env });

const retiringCipher: FieldCipher = {
  encrypt: (plaintext: string) => plaintext,
  decrypt: (payload: string) => payload
};

const rotatingVault: CredentialVault = createCredentialVault({
  store, catalog, cipher, previousCipher: retiringCipher, env: process.env
});

const rotation: CredentialRotation = createCredentialRotation({
  store,
  catalog,
  to: cipher,
  from: retiringCipher,
  logger: { warn: () => {}, error: () => {} }
});

const challenge: UnlockChallenge = createUnlockChallenge({
  store: challengeStore,
  deliverCode: async ({ code, expiresInMs }) => ({ sentTo: maskEmail('founder@example.com'), code, expiresInMs }),
  codeTtlMs: DEFAULT_CODE_TTL_MS,
  windowMs: DEFAULT_WINDOW_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  resendDelayMs: DEFAULT_RESEND_DELAY_MS
});

const router = createCredentialsRoutes({
  vault,
  challenge,
  authorize: (_req: RequestLike, _res: ResponseLike, next: NextFunction) => next(),
  subjectOf: (req) => (req as { user: { id: string } }).user.id,
  logger: { info: () => {} }
});

async function exercise(): Promise<void> {
  const value: string | null = await vault.get('GROQ_API_KEY');
  const many: Record<string, string | null> = await vault.getMany(managedKeys);
  const stored: Map<string, string | null> = await vault.stored();
  const status: CredentialStatus = await vault.status();
  await vault.set('GROQ_API_KEY', 'gsk-1', { updatedBy: 'user-1' });
  await vault.disconnect('GROQ_API_KEY', { updatedBy: 'user-1' });
  vault.forget();

  const hydration: HydrationResult = await hydrator.hydrate(managedKeys);
  const stop: () => void = hydrator.startRefresh(managedKeys, { intervalMs: 60_000, onChange: () => {} });
  stop();
  hydrator.reset();

  await challenge.requestCode('user-1');
  await challenge.verifyCode('user-1', '123456');
  const until: Date | null = await challenge.unlockedUntil('user-1');
  await challenge.assertUnlocked('user-1');

  await mongoStore.findAll();
  await mongoChallengeStore.find('user-1');
  await challengeStore.save('user-1', { attempts: 0 });

  assertAdapter(store, ['findAll', 'upsert'], 'store');

  const planned: RotationReport = await rotation.plan();
  const applied: RotationReport = await rotation.apply();
  const completion: RotationCompletion = await rotation.isComplete();
  const decision = rotation.decide({ key: 'GROQ_API_KEY', value: 'ciphertext' });
  const rotating: boolean = rotatingVault.isRotating();

  void [planned, applied, completion, decision.status, rotating];

  void [
    value, many, stored, status, hydration, until, router, DISCONNECTED,
    catalogChecks, classes, mayRead, mayWriteReason, restricted,
    maskSecret('sk_test_abcd1234'), vault.mask('x'), challenge.windowMs
  ];
}

void exercise;
