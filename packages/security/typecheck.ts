import {
  CHALLENGE_TTL_MS,
  RECOVERY_CODE_COUNT,
  WAF_PATTERNS,
  authorizeRoles,
  createAccountLimiter,
  createApiLimiter,
  createAuthMiddleware,
  createLoginLimiter,
  createWafMiddleware,
  createWebauthnService,
  hashRecoveryCode,
  rpConfigForRequest,
  skipLocalhost
} from '@astratra/security';

const middleware = createAuthMiddleware({
  secret: 'secret',
  legacySecret: 'legacy',
  message: { success: false, message: 'No' },
  extractToken: (req) => req.headers?.authorization ?? null,
  verifySession: async (decoded) => Boolean(decoded)
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
