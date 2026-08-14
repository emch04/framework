jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(async () => ({ challenge: 'registration-challenge' })),
  verifyRegistrationResponse: jest.fn(async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: 'credential-1',
        publicKey: Buffer.from('public-key'),
        counter: 1,
        transports: ['internal']
      }
    }
  })),
  generateAuthenticationOptions: jest.fn(async () => ({ challenge: 'authentication-challenge' })),
  verifyAuthenticationResponse: jest.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 2 }
  }))
}));

const simpleWebauthn = require('@simplewebauthn/server');
const { createWebauthnService } = require('../src');

const createStore = () => ({
  credentials: [],
  challenges: [],
  recoveryHashes: new Set(),
  getCredentialsForUser: jest.fn(async (userId) => createStoreState.credentials.filter((credential) => credential.userId === userId)),
  saveCredential: jest.fn(async (userId, credential) => {
    createStoreState.credentials.push({ userId, ...credential });
  }),
  getCredentialById: jest.fn(async (credentialId) => createStoreState.credentials.find((credential) => credential.credentialID === credentialId)),
  updateCredentialCounter: jest.fn(async (credentialId, counter) => {
    const credential = createStoreState.credentials.find((item) => item.credentialID === credentialId);
    credential.counter = counter;
  }),
  saveChallenge: jest.fn(async (userId, challenge, purpose, metadata) => {
    createStoreState.challenges.push({ userId, challenge, purpose, metadata });
  }),
  consumeChallenge: jest.fn(async (userId, purpose) => {
    const index = createStoreState.challenges.findIndex((item) => item.userId === userId && item.purpose === purpose);
    return index === -1 ? null : createStoreState.challenges.splice(index, 1)[0];
  }),
  saveRecoveryCodes: jest.fn(async (userId, codeHashes) => {
    createStoreState.recoveryHashes.set(userId, new Set(codeHashes));
  }),
  consumeRecoveryCode: jest.fn(async (userId, codeHash) => {
    const hashes = createStoreState.recoveryHashes.get(userId);
    if (!hashes || !hashes.has(codeHash)) return false;
    hashes.delete(codeHash);
    return true;
  })
});

let createStoreState;

describe('webauthn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createStoreState = { credentials: [], challenges: [], recoveryHashes: new Map() };
    process.env.WEBAUTHN_ALLOWED_ORIGINS = 'https://app.example.com';
    delete process.env.CLIENT_URL;
  });

  test('starts registration with existing credentials excluded and saves challenge', async () => {
    const store = createStore();
    createStoreState.credentials.push({ userId: 'u1', credentialID: 'existing', transports: ['internal'] });
    const service = createWebauthnService(store, { rpName: 'Example' });

    const options = await service.getRegistrationOptions(
      { headers: { origin: 'https://app.example.com' } },
      'u1',
      'alice@example.com'
    );

    expect(options).toEqual({ challenge: 'registration-challenge' });
    expect(simpleWebauthn.generateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({
      rpName: 'Example',
      rpID: 'app.example.com',
      userName: 'alice@example.com',
      excludeCredentials: [{ id: 'existing', transports: ['internal'] }]
    }));
    expect(store.saveChallenge).toHaveBeenCalledWith(
      'u1',
      'registration-challenge',
      'registration',
      expect.objectContaining({ rpID: 'app.example.com', origin: 'https://app.example.com' })
    );
  });

  test('verifies registration, saves credential, and generates recovery codes for first device', async () => {
    const store = createStore();
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });
    await store.saveChallenge('u1', 'registration-challenge', 'registration', {
      origin: 'https://app.example.com',
      rpID: 'app.example.com'
    });

    const result = await service.verifyRegistration('u1', { response: true }, 'Laptop');

    expect(simpleWebauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: 'registration-challenge',
      expectedOrigin: 'https://app.example.com',
      expectedRPID: 'app.example.com'
    }));
    expect(store.saveCredential).toHaveBeenCalledWith('u1', expect.objectContaining({
      credentialID: 'credential-1',
      publicKey: expect.any(String),
      counter: 1,
      transports: ['internal'],
      deviceName: 'Laptop'
    }));
    expect(result.recoveryCodes).toHaveLength(10);
    expect(store.saveRecoveryCodes).toHaveBeenCalledWith('u1', expect.arrayContaining([expect.any(String)]));
  });

  test('starts authentication and verifies response while updating counter', async () => {
    const store = createStore();
    createStoreState.credentials.push({
      userId: 'u1',
      credentialID: 'credential-1',
      publicKey: Buffer.from('public-key').toString('base64url'),
      counter: 1,
      transports: ['internal']
    });
    const service = createWebauthnService(store);

    await service.getAuthenticationOptions({ headers: { origin: 'https://app.example.com' } }, 'u1');
    await service.verifyAuthentication('u1', { id: 'credential-1' });

    expect(simpleWebauthn.generateAuthenticationOptions).toHaveBeenCalledWith(expect.objectContaining({
      allowCredentials: [{ id: 'credential-1', transports: ['internal'] }]
    }));
    expect(simpleWebauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      credential: expect.objectContaining({ id: 'credential-1', counter: 1 })
    }));
    expect(store.updateCredentialCounter).toHaveBeenCalledWith('credential-1', 2);
  });

  test('rejects authentication when the credential belongs to another user', async () => {
    const store = createStore();
    createStoreState.credentials.push({
      userId: 'u2',
      credentialID: 'credential-2',
      publicKey: Buffer.from('public-key').toString('base64url'),
      counter: 1,
      transports: ['internal']
    });
    const service = createWebauthnService(store);
    await store.saveChallenge('u1', 'authentication-challenge', 'authentication', {
      origin: 'https://app.example.com',
      rpID: 'app.example.com'
    });

    await expect(service.verifyAuthentication('u1', { id: 'credential-2' }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(simpleWebauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  test('rejects expired authentication challenges', async () => {
    const store = createStore();
    createStoreState.credentials.push({
      userId: 'u1',
      credentialID: 'credential-1',
      publicKey: Buffer.from('public-key').toString('base64url'),
      counter: 1,
      transports: ['internal']
    });
    const service = createWebauthnService(store);
    await store.saveChallenge('u1', 'authentication-challenge', 'authentication', {
      origin: 'https://app.example.com',
      rpID: 'app.example.com',
      expiresAt: new Date(Date.now() - 1000)
    });

    await expect(service.verifyAuthentication('u1', { id: 'credential-1' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(simpleWebauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  test('rejects disallowed origins', async () => {
    const service = createWebauthnService(createStore());

    await expect(service.getRegistrationOptions(
      { headers: { origin: 'https://evil.example.com' } },
      'u1',
      'alice@example.com'
    )).rejects.toMatchObject({ statusCode: 403 });
  });

  test('generates and consumes recovery codes through the store', async () => {
    const store = createStore();
    const service = createWebauthnService(store, { recoveryCodeSecret: 'pepper' });

    const codes = await service.generateRecoveryCodes('u1');
    const firstUse = await service.verifyRecoveryCode('u1', codes[0]);
    const secondUse = await service.verifyRecoveryCode('u1', codes[0]);

    expect(codes).toHaveLength(10);
    expect(firstUse).toBe(true);
    expect(secondUse).toBe(false);
    expect(store.consumeRecoveryCode).toHaveBeenCalledWith('u1', expect.any(String));
  });
});

describe('createMemoryWebauthnStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WEBAUTHN_ALLOWED_ORIGINS = 'https://app.example.com';
    delete process.env.CLIENT_URL;
  });

  test('satisfies the full WebauthnStore contract through a real registration + authentication cycle', async () => {
    const { createMemoryWebauthnStore } = require('../src');
    const store = createMemoryWebauthnStore();
    const service = createWebauthnService(store, { rpName: 'Example', recoveryCodeSecret: 'pepper' });

    // Registration
    await service.getRegistrationOptions({ headers: { origin: 'https://app.example.com' } }, 'u1', 'alice@example.com');
    const registration = await service.verifyRegistration('u1', {}, 'MacBook');
    expect(registration.verified).toBe(true);
    expect(registration.isFirstDevice).toBe(true);
    expect(registration.recoveryCodes).toHaveLength(10);
    expect(await service.hasCredentials('u1')).toBe(true);

    // Authentication (before a second user registers — the mocked
    // verifyRegistrationResponse always returns the same fake credential
    // id, which would otherwise collide across users the way two real
    // WebAuthn ceremonies never would)
    await service.getAuthenticationOptions({ headers: { origin: 'https://app.example.com' } }, 'u1');
    const authenticated = await service.verifyAuthentication('u1', { id: 'credential-1' });
    expect(authenticated).toBe(true);

    // The counter update from verifyAuthentication (newCounter: 2, per the mock) persisted
    const [credential] = await store.getCredentialsForUser('u1');
    expect(credential.counter).toBe(2);

    // Challenges are one-time use
    await expect(service.verifyAuthentication('u1', { id: 'credential-1' })).rejects.toMatchObject({ statusCode: 400 });

    // Recovery codes: one-time use, scoped per user
    const firstUse = await service.verifyRecoveryCode('u1', registration.recoveryCodes[0]);
    const secondUse = await service.verifyRecoveryCode('u1', registration.recoveryCodes[0]);
    expect(firstUse).toBe(true);
    expect(secondUse).toBe(false);

    // A second user's credential list is independent of the first's
    await service.getRegistrationOptions({ headers: { origin: 'https://app.example.com' } }, 'u2', 'bob@example.com');
    await service.verifyRegistration('u2', {}, 'iPhone');
    const u1Credentials = await store.getCredentialsForUser('u1');
    expect(u1Credentials).toHaveLength(1);
    expect(await service.hasCredentials('u2')).toBe(true);
  });
});
