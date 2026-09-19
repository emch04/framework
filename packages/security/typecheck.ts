import {
  RefreshTokenError,
  createMemoryRefreshTokenStore,
  createRefreshTokenService,
  CHALLENGE_TTL_MS,
  GENESIS_HASH,
  createAuditChain,
  createMemoryAuditStore,
  createServiceSigner,
  hashEvent,
  stableStringify,
  DEFAULT_CSP_DIRECTIVES,
  DEFAULT_SESSION_COOKIE_NAME,
  RECOVERY_CODE_COUNT,
  WAF_PATTERNS,
  authorizeRoles,
  clearSessionCookie,
  cookieParserMiddleware,
  createAccountLimiter,
  createApiLimiter,
  createAuthMiddleware,
  createCspMiddleware,
  createCsrfMiddleware,
  createLoginLimiter,
  createMemoryRevocationStore,
  createWafMiddleware,
  createWebauthnService,
  hashRecoveryCode,
  parseCookieHeader,
  rpConfigForRequest,
  setSessionCookie,
  skipLocalhost
} from '@astratra/security';
import type {
  IssuedRefreshToken,
  RefreshTokenErrorCode,
  RefreshTokenService,
  RefreshTokenStore
} from '@astratra/security';

createCspMiddleware();
createCspMiddleware({
  reportOnly: true,
  directives: {
    ...DEFAULT_CSP_DIRECTIVES,
    'default-src': ["'self'"]
  }
});

const middleware = createAuthMiddleware({
  secret: 'secret',
  legacySecret: 'legacy',
  message: { success: false, message: 'No' },
  extractToken: (req) => req.headers?.authorization ?? null,
  verifySession: async (decoded) => Boolean(decoded)
});

const revocationStore = createMemoryRevocationStore();
revocationStore.revoke('token-id', Date.now() + 3600000);
revocationStore.isRevoked('token-id');
revocationStore.revokeAllForUser?.('user-id', Date.now());
revocationStore.isRevokedForUser?.('user-id', Math.floor(Date.now() / 1000));
createAuthMiddleware({
  secret: 'secret',
  revocationStore
});

middleware({ headers: { authorization: 'Bearer token' } }, { status: () => ({ json: () => undefined }) }, () => {});
authorizeRoles('owner', 'admin')({ user: { role: 'owner' } }, { status: () => ({ json: () => undefined }) }, () => {});

createApiLimiter({ windowMs: 1000, max: 20, redisUrl: 'redis://localhost:6379' });
createLoginLimiter({
  skip: (req) => skipLocalhost(req),
  onBlocked: async (context) => {
    const ip: string = context.ip;
    void ip;
  }
});
createAccountLimiter({
  keyGenerator: (req) => String(req.body?.email ?? 'unknown'),
  onBlocked: (context) => {
    // identifier is `unknown` by design: it comes straight from req.body
    // (email or identifier field) without a runtime type guarantee.
    const identifier = String(context.identifier);
    void identifier;
  }
});

createWafMiddleware({ message: { success: false }, patterns: WAF_PATTERNS });

const cookieRes = { setHeader: () => undefined, getHeader: () => undefined, status: () => ({ json: () => undefined }) };
void DEFAULT_SESSION_COOKIE_NAME;
const parsedCookies: Record<string, string> = parseCookieHeader('a=b; c=d');
void parsedCookies;
cookieParserMiddleware()({ headers: { cookie: 'a=b' } }, cookieRes, () => {});
setSessionCookie(cookieRes, 'jwt-token', { name: 'app_session', sameSite: 'strict', secure: true, maxAgeMs: 3600000 });
clearSessionCookie(cookieRes, { name: 'app_session' });
createCsrfMiddleware({
  headerName: 'x-csrf-token',
  skip: (req) => req.path === '/webhook'
})({ method: 'POST', path: '/api', cookies: {}, headers: {} }, cookieRes, () => {});
const rp = rpConfigForRequest({ headers: { origin: 'http://localhost:3000' } }, { clientUrl: 'http://localhost:3000' });
const hash: string = hashRecoveryCode('abcd-1234', 'secret');

const webauthnStore = {
  async getCredentialsForUser(_userId: string) {
    return [{
      credentialID: 'credential-id',
      publicKey: 'public-key',
      counter: 0,
      transports: ['internal']
    }];
  },
  async saveCredential(_userId: string, _credential: { credentialID: string; publicKey: string; counter: number; transports: string[]; deviceName: string }) {},
  async getCredentialById(_credentialId: string) {
    return {
      credentialID: 'credential-id',
      publicKey: 'public-key',
      counter: 0,
      transports: ['internal']
    };
  },
  async updateCredentialCounter(_credentialId: string, _counter: number) {},
  async saveChallenge(_userId: string, _challenge: string, _type: 'registration' | 'authentication', _metadata: { rpID: string; origin: string; expiresAt: Date }) {},
  async consumeChallenge(_userId: string, _type: 'registration' | 'authentication') {
    return {
      challenge: 'challenge',
      rpID: 'localhost',
      origin: 'http://localhost:3000'
    };
  },
  async saveRecoveryCodes(_userId: string, _hashes: string[]) {},
  async consumeRecoveryCode(_userId: string, _hash: string) {
    return true;
  }
};

const webauthn = createWebauthnService(webauthnStore, {
  allowedOrigins: ['http://localhost:3000'],
  clientUrl: 'http://localhost:3000',
  rpName: 'Astratra',
  challengeTtlMs: CHALLENGE_TTL_MS,
  recoveryCodeCount: RECOVERY_CODE_COUNT,
  recoveryCodeSecret: 'secret'
});

webauthn.getRegistrationOptions({ headers: { origin: 'http://localhost:3000' } }, 'user-1', 'owner@example.test');
webauthn.verifyRegistration('user-1', { id: 'response' }, 'MacBook');
webauthn.getAuthenticationOptions({ headers: { origin: 'http://localhost:3000' } }, 'user-1');
webauthn.verifyAuthentication('user-1', { id: 'credential-id' });
webauthn.hasCredentials('user-1');
webauthn.generateRecoveryCodes('user-1');
webauthn.verifyRecoveryCode('user-1', 'abcd-1234');
webauthn.hashRecoveryCode('abcd-1234');
webauthn.rpConfigForRequest({ headers: { origin: 'http://localhost:3000' } });
void rp;
void hash;

const signer = createServiceSigner({ secret: 'shared', maxAgeMs: 30_000, now: () => Date.now() });
const signed = signer.sign({ id: 'u1', role: 'admin' });
const checked = signer.verify<{ id: string }>(signed.payload, signed.signature);
const sentHeaders: Record<string, string> = signer.headers({ id: 'u1' });
const fromHeaders = signer.verifyHeaders(sentHeaders);

const auditStore = createMemoryAuditStore();
const chain = createAuditChain({
  store: auditStore,
  now: () => new Date(),
  logger: { error: () => {} },
  onRecordFailed: (error, event) => void [error, event]
});

async function exerciseAudit(): Promise<void> {
  await chain.record({ type: 'login', actor: 'u1', message: 'signed in' });
  const report = await chain.verify();
  const direct = await chain.verify(auditStore.entries);
  void [
    report.intact, report.failure?.reason, direct.checked,
    chain.hashEvent({ type: 'x' }), hashEvent({ type: 'x' }), GENESIS_HASH,
    stableStringify({ b: 1, a: 2 }),
    checked.valid, fromHeaders.valid, signed.issuedAt
  ];
}

void exerciseAudit;

/* ────────────────────────── Refresh tokens ────────────────────────── */

const refreshStore: RefreshTokenStore = createMemoryRefreshTokenStore();

const refreshTokens: RefreshTokenService = createRefreshTokenService({
  store: refreshStore,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  now: () => Date.now(),
  randomToken: () => 'token'
});

async function exerciseRefreshTokens(): Promise<void> {
  const issued: IssuedRefreshToken = await refreshTokens.issue({ userId: 'u1' });
  try {
    const next: IssuedRefreshToken = await refreshTokens.rotate(issued.token);
    void next.familyId;
  } catch (error) {
    if (error instanceof RefreshTokenError) {
      const code: RefreshTokenErrorCode = error.code;
      void code;
    }
  }
  await refreshTokens.revokeFamily(issued.familyId);
  await refreshTokens.revokeAllForUser('u1');
  void [await refreshTokens.prune(), refreshTokens.fingerprint('x'), issued.expiresAt];
}

void exerciseRefreshTokens;

/* ────────────────────────── Private file links ────────────────────────── */

import {
  createPrivateFileLinks,
  serializeForReader,
  serializeForBroadcast,
  resolveStoredFile,
  privateFileHeaders,
  createPrivateFileHandler,
  PRIVATE_FILE_STEP_SECONDS,
  ipFamily,
  createMemoryLoginDeviceStore,
  createLoginDeviceTracker,
  createChangeAlerts,
  createSecurityAlerter,
  CHANGE_TYPES,
  TrustedDeviceError,
  createTrustedDeviceService,
  createMemoryTrustedDeviceStore,
  createMemoryAttemptCounter,
  TRUSTED_DEVICE_ID_PATTERN
} from '@astratra/security';
import type { PrivateFileLinks, PrivateFileLinkCheck, ChangeType, TrustedDeviceExchange } from '@astratra/security';

const fileLinks: PrivateFileLinks = createPrivateFileLinks({
  secret: 'x'.repeat(32),
  basePath: '/api/files',
  accountVersion: async () => 0
});

async function exerciseFileLinks(): Promise<void> {
  const signed = fileLinks.sign({ kind: 'messages', fileId: 'f1', accountId: 'u1', version: 2 });
  const check: PrivateFileLinkCheck = await fileLinks.verify(signed.ticket, { kind: 'messages', fileId: 'f1' });
  if (check.valid) void check.accountId; else void check.reason;
  const forReader = serializeForReader({ fileUrl: '/x' }, { links: fileLinks, reader: { id: 'u1' }, kind: 'messages' });
  const broadcast = serializeForBroadcast([{ fileUrl: '/x' }], { links: fileLinks, kind: () => 'messages', clearWhenDeleted: ['fileThumb'] });
  const handler = createPrivateFileHandler<{ path: string }>({
    links: fileLinks,
    authenticate: (_req, _res, next) => next(),
    loadFile: async () => ({ path: '/x' }),
    canRead: async () => true,
    loadReader: async (id) => ({ id }),
    send: async () => undefined
  });
  void [forReader.fileUrl, broadcast.length, handler, fileLinks.pathFor('messages', 'f1'), fileLinks.linkFor('messages', 'f1', null),
    resolveStoredFile('/srv', 'a.jpg'), privateFileHeaders({ mime: 'image/png' })['Content-Disposition'], PRIVATE_FILE_STEP_SECONDS];
}

void exerciseFileLinks;

/* ────────────────────────── Sign-in devices ────────────────────────── */

async function exerciseLoginDevices(): Promise<void> {
  const tracker = createLoginDeviceTracker<{ id: string; locale: string }>({
    store: createMemoryLoginDeviceStore(),
    secret: 'x'.repeat(16),
    notify: async (account, event) => { void [account.locale, event.type]; }
  });
  const recorded = await tracker.record({ id: 'u1' }, { ip: '203.0.113.7', userAgent: 'UA' });
  const alerts = createChangeAlerts<{ locale: string }>({ send: async (message) => { void [message.key, message.locale]; } });
  const change: ChangeType = CHANGE_TYPES[0];
  const sent: boolean = await alerts.alert({ locale: 'fr' }, change, { to: 'a@b.test' });
  const alerter = createSecurityAlerter({ channels: [async (a) => a.level] });
  void [recorded.isNew, sent, await alerter.send({ level: 'FATAL', type: 'replay' }), ipFamily('::1')];
}

void exerciseLoginDevices;

/* ────────────────────────── Trusted devices ────────────────────────── */

async function exerciseTrustedDevices(): Promise<void> {
  const trusted = createTrustedDeviceService({
    store: createMemoryTrustedDeviceStore(),
    attempts: createMemoryAttemptCounter(),
    pepper: 'x'.repeat(32),
    onReplay: async ({ accountId }) => { void accountId; }
  });
  const enrolled = await trusted.enroll({ accountId: 'u1', credentialStamp: 'hash', platform: 'ios' });
  try {
    const next: TrustedDeviceExchange = await trusted.exchange(enrolled, { loadAccount: async () => ({ credentialStamp: 'hash' }) });
    void next.secret;
  } catch (error) {
    if (error instanceof TrustedDeviceError) void [error.code, error.statusCode, error.retryAfterMs];
  }
  await trusted.forget(enrolled);
  void [await trusted.list('u1'), await trusted.remove('u1', enrolled.id), await trusted.revokeAll('u1'),
    TRUSTED_DEVICE_ID_PATTERN.test(enrolled.deviceId)];
}

void exerciseTrustedDevices;
