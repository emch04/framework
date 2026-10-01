'use strict';

const { spawnSync } = require('node:child_process');
const { startMongo, startPostgres, isDockerAvailable, mongoUri, assertSafeTestDatabaseUri, UnsafeTestDatabaseError } = require('../src');

function fakeLoader({ mongoString = 'mongodb://127.0.0.1:49153', pgUri = 'postgres://test:test@localhost:49154/astratra_test' } = {}) {
  const stopped = [];
  class MongoDBContainer {
    constructor(image) { this.image = image; }
    async start() { return { getConnectionString: () => mongoString, stop: async () => stopped.push('mongo') }; }
  }
  class PostgreSqlContainer {
    constructor(image) { this.image = image; }
    withDatabase(db) { this.db = db; return this; }
    async start() { return { getConnectionUri: () => pgUri, stop: async () => stopped.push('pg') }; }
  }
  return { stopped, loader: (name) => (name === '@testcontainers/mongodb' ? { MongoDBContainer } : { PostgreSqlContainer }) };
}

describe('démarrage des conteneurs (doublure)', () => {
  test('MongoDB : URI avec nom de base et directConnection, arrêt idempotent', async () => {
    const { loader, stopped } = fakeLoader();
    const db = await startMongo({ loader, env: {}, database: 'scolaris_test' });
    expect(db.uri).toBe('mongodb://127.0.0.1:49153/scolaris_test?directConnection=true');
    await db.stop();
    await db.stop();
    expect(stopped).toEqual(['mongo']);
  });

  test('Postgres', async () => {
    const { loader } = fakeLoader();
    const db = await startPostgres({ loader, env: {} });
    expect(db.uri).toContain('astratra_test');
    expect(db.engine).toBe('postgres');
  });

  test('refuse de démarrer en production', async () => {
    const { loader } = fakeLoader();
    await expect(startMongo({ loader, env: { NODE_ENV: 'production' } })).rejects.toBeInstanceOf(UnsafeTestDatabaseError);
  });

  test('si l’URI obtenue n’est pas sûre, le conteneur est arrêté et l’appel échoue', async () => {
    const { loader, stopped } = fakeLoader({ pgUri: 'postgres://u:p@cluster.supabase.co/astratra_test' });
    await expect(startPostgres({ loader, env: {} })).rejects.toMatchObject({ code: 'UNSAFE_TEST_DATABASE' });
    expect(stopped).toEqual(['pg']);
  });

  test('détection de Docker avec une doublure de processus', () => {
    expect(isDockerAvailable({ spawn: () => ({ status: 0 }) })).toBe(true);
    expect(isDockerAvailable({ spawn: () => ({ status: 1 }) })).toBe(false);
    expect(isDockerAvailable({ spawn: () => { throw new Error('ENOENT'); } })).toBe(false);
  });

  test('mongoUri conserve les paramètres existants', () => {
    expect(mongoUri('mongodb://u:p@h:1?authSource=admin', 'db')).toBe('mongodb://u:p@h:1/db?authSource=admin&directConnection=true');
    expect(() => assertSafeTestDatabaseUri(mongoUri('mongodb://u:p@h:1?authSource=admin', 'db'), { env: {} })).not.toThrow();
  });
});

// Vrai conteneur : seulement si un démon Docker répond, sinon ignoré (Docker n'est pas partout).
const docker = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
const real = docker ? describe : describe.skip;
real('vrais conteneurs jetables (Docker requis)', () => {
  test('MongoDB démarre, répond, puis s’arrête', async () => {
    const db = await startMongo({ database: 'testkit_test' });
    try {
      expect(db.uri).toMatch(/^mongodb:\/\/.*\/testkit_test/);
    } finally {
      await db.stop();
    }
  }, 180_000);
  test('Postgres démarre puis s’arrête', async () => {
    const db = await startPostgres();
    try {
      expect(db.uri).toMatch(/^postgres(ql)?:\/\//);
    } finally {
      await db.stop();
    }
  }, 180_000);
});
