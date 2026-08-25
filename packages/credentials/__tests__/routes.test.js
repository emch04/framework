const express = require('express');
const request = require('supertest');
const { errorMiddleware } = require('@astratra/core');
const { createFieldCipher, generateFieldEncryptionKey } = require('@astratra/security');
const {
  createCredentialCatalog,
  createCredentialVault,
  createCredentialsRoutes,
  createMemoryChallengeStore,
  createMemoryCredentialStore,
  createUnlockChallenge
} = require('../src');

const catalog = createCredentialCatalog({
  spaces: [{ id: 'ai', label: 'AI', keys: [{ key: 'GROQ_API_KEY', label: 'Groq' }] }],
  reservedKeys: ['ENCRYPTION_KEY']
});

function build({ withChallenge = true, role = 'owner' } = {}) {
  const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
  const store = createMemoryCredentialStore();
  const env = {};
  const vault = createCredentialVault({ store, catalog, cipher, env, cacheMs: 0 });

  const delivered = [];
  const challenge = withChallenge
    ? createUnlockChallenge({
      store: createMemoryChallengeStore(),
      deliverCode: async ({ code }) => { delivered.push(code); return { sentTo: 'fo•••@example.com' }; }
    })
    : null;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'user-1', role }; next(); });
  app.use('/api/credentials', createCredentialsRoutes({
    vault,
    challenge,
    authorize: (req, res, next) => (
      req.user.role === 'owner' ? next() : res.status(403).json({ success: false, message: 'Forbidden' })
    )
  }));
  app.use(errorMiddleware);

  return { app, vault, delivered, store };
}

async function unlock(app, delivered) {
  await request(app).post('/api/credentials/challenge').expect(200);
  return request(app)
    .post('/api/credentials/unlock')
    .send({ code: delivered[delivered.length - 1] })
    .expect(200);
}

describe('credentials routes', () => {
  test('an account without the role never reaches the keys', async () => {
    const { app } = build({ role: 'member' });

    await request(app).get('/api/credentials').expect(403);
    await request(app).put('/api/credentials/GROQ_API_KEY').send({ value: 'x' }).expect(403);
  });

  test('the status lists the keys and never carries a value', async () => {
    const { app, vault, delivered } = build();
    await vault.set('GROQ_API_KEY', 'gsk-abcdefgh1234');

    const response = await request(app).get('/api/credentials').expect(200);

    expect(response.body.data.spaces[0].keys[0]).toMatchObject({
      key: 'GROQ_API_KEY',
      configured: true,
      preview: '••••1234'
    });
    expect(response.text).not.toContain('gsk-abcdefgh1234');
    expect(response.body.data.unlockedUntil).toBeNull();
    expect(delivered).toHaveLength(0);
  });

  test('storing a key is refused until the emailed code has been used', async () => {
    const { app } = build();

    await request(app).put('/api/credentials/GROQ_API_KEY').send({ value: 'gsk-1' }).expect(403);
  });

  test('once unlocked, a key can be stored and then unplugged', async () => {
    const { app, vault, delivered } = build();
    await unlock(app, delivered);

    await request(app).put('/api/credentials/GROQ_API_KEY').send({ value: 'gsk-1' }).expect(200);
    expect(await vault.get('GROQ_API_KEY')).toBe('gsk-1');

    await request(app).delete('/api/credentials/GROQ_API_KEY').expect(200);
    expect(await vault.get('GROQ_API_KEY')).toBeNull();
  });

  test('the status reports the open window so the screen can offer editing', async () => {
    const { app, delivered } = build();
    await unlock(app, delivered);

    const response = await request(app).get('/api/credentials').expect(200);

    expect(response.body.data.unlockedUntil).not.toBeNull();
  });

  test('a wrong code does not open anything', async () => {
    const { app } = build();
    await request(app).post('/api/credentials/challenge').expect(200);

    await request(app).post('/api/credentials/unlock').send({ code: '000000' }).expect(400);
    await request(app).put('/api/credentials/GROQ_API_KEY').send({ value: 'x' }).expect(403);
  });

  test('an unknown key is refused even with the window open', async () => {
    const { app, delivered } = build();
    await unlock(app, delivered);

    await request(app).put('/api/credentials/ANYTHING_ELSE').send({ value: 'x' }).expect(400);
  });

  test('a reserved key is refused even with the window open', async () => {
    const { app, delivered } = build();
    await unlock(app, delivered);

    await request(app).put('/api/credentials/ENCRYPTION_KEY').send({ value: 'x' }).expect(400);
  });

  test('an empty value is rejected before it reaches the vault', async () => {
    const { app, delivered } = build();
    await unlock(app, delivered);

    await request(app).put('/api/credentials/GROQ_API_KEY').send({ value: '  ' }).expect(400);
  });

  test('without a challenge configured, the unlock endpoints say so plainly', async () => {
    const { app } = build({ withChallenge: false });

    await request(app).post('/api/credentials/challenge').expect(404);
    // ...and writes go straight through: that is the caller's decision to make.
    await request(app).put('/api/credentials/GROQ_API_KEY').send({ value: 'gsk-1' }).expect(200);
  });

  test('wiring without an authorize middleware is refused up front', () => {
    const vault = createCredentialVault({
      store: createMemoryCredentialStore(),
      catalog,
      cipher: createFieldCipher({ key: generateFieldEncryptionKey() })
    });

    expect(() => createCredentialsRoutes({ vault })).toThrow(/authorize/);
  });
});
