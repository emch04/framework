const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { newDb } = require('pg-mem');
const { createMemoryPersistence, createPostgresPersistence, createMongoPersistence, assertPersistence } = require('../src');

let mongo;
let connexion;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connexion = await mongoose.createConnection(mongo.getUri()).asPromise();
}, 180000); // premier lancement : téléchargement du binaire MongoDB
afterAll(async () => {
  await connexion?.close();
  await mongo?.stop();
});

const octets = (...n) => new Uint8Array(n);
const version = (id, createdAt, state, extra = {}) => ({
  id, documentName: 'doc', label: `v-${id}`, author: 'u1', kind: 'manual', size: state.byteLength, createdAt, state, ...extra
});

const moteurs = {
  mémoire: async () => createMemoryPersistence(),
  postgres: async () => {
    const { Pool } = newDb().adapters.createPg();
    return createPostgresPersistence({ pool: new Pool() });
  },
  mongo: async () => {
    await connexion.dropDatabase();
    return createMongoPersistence({ db: connexion });
  }
};

describe.each(Object.keys(moteurs))('persistance %s', (nom) => {
  let p;
  beforeEach(async () => {
    p = assertPersistence(await moteurs[nom]());
  });

  test('document absent → null ; écrit puis relu à l’octet près, et réécrit', async () => {
    expect(await p.load('doc')).toBeNull();
    await p.store('doc', octets(1, 2, 3), { size: 3, updatedAt: '2026-10-01T08:00:00.000Z' });
    expect(Array.from(await p.load('doc'))).toEqual([1, 2, 3]);
    await p.store('doc', octets(9, 8), { size: 2, updatedAt: '2026-10-01T09:00:00.000Z' });
    const relu = await p.load('doc');
    expect(relu).toBeInstanceOf(Uint8Array);
    expect(Array.from(relu)).toEqual([9, 8]);
  });

  test('versions : liste sans instantané, la plus récente d’abord ; lecture complète par id', async () => {
    await p.saveVersion('doc', version('a', '2026-10-01T08:00:00.000Z', octets(1)));
    await p.saveVersion('doc', version('b', '2026-10-01T10:00:00.000Z', octets(2, 2), { kind: 'backup', author: null }));
    await p.saveVersion('autre', { ...version('c', '2026-10-01T11:00:00.000Z', octets(3)), documentName: 'autre' });

    const liste = await p.listVersions('doc');
    expect(liste.map((v) => v.id)).toEqual(['b', 'a']);
    expect(liste[0]).toEqual({
      id: 'b', documentName: 'doc', label: 'v-b', author: null, kind: 'backup', size: 2, createdAt: '2026-10-01T10:00:00.000Z'
    });
    expect(liste[0]).not.toHaveProperty('state');

    const complete = await p.getVersion('doc', 'a');
    expect(Array.from(complete.state)).toEqual([1]);
    expect(await p.getVersion('doc', 'c')).toBeNull();
    expect(await p.getVersion('doc', 'inconnue')).toBeNull();
  });
});

test('postgres refuse un nom de table qui ouvrirait une injection', () => {
  expect(() => createPostgresPersistence({ pool: { query: async () => ({ rows: [] }) }, documentsTable: 'x; DROP TABLE y' })).toThrow(TypeError);
});
