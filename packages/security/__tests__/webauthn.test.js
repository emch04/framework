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
