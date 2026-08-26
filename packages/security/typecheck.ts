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
