'use strict';

const { assertSafeTestDatabaseUri, isSafeTestDatabaseUri, parseDatabaseUri, UnsafeTestDatabaseError } = require('../src');

const refuses = (uri, reason, options) => {
  let error;
  try { assertSafeTestDatabaseUri(uri, { env: {}, ...options }); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(UnsafeTestDatabaseError);
  expect(error.reason).toBe(reason);
};

describe('garde-fou des URI de base de test', () => {
  test('accepte les bases locales', () => {
    for (const uri of [
      'mongodb://localhost:27017/scolaris_test',
      'mongodb://127.0.0.1:55000/?directConnection=true',
      'mongodb://user:pa%40ss@[::1]:27017/app',
      'postgres://test:test@localhost:5432/astratra_test',
      'postgresql://u:p@db.localhost/app',
      'mongodb://mongo:27017/app',
      'mongodb://replica1.test:27017,replica2.test:27017/app?replicaSet=rs'
    ]) expect(isSafeTestDatabaseUri(uri, { env: {} })).toBe(true);
  });

  test('refuse NODE_ENV=production, même pour une URI locale', () => {
    refuses('mongodb://localhost/app_test', 'NODE_ENV_PRODUCTION', { env: { NODE_ENV: 'production' } });
  });

  test('refuse Atlas et les bases hébergées, même listées', () => {
    refuses('mongodb+srv://u:p@cluster0.ab1cd.mongodb.net/app_test', 'MANAGED_PROVIDER');
    refuses('mongodb://shard-00.ab1cd.mongodb.net:27017/app_test', 'MANAGED_PROVIDER', { allowRemoteHosts: ['shard-00.ab1cd.mongodb.net'] });
    refuses('postgres://u:p@db.abc.supabase.co:5432/postgres', 'MANAGED_PROVIDER');
    refuses('postgres://u:p@mydb.xyz.eu-west-1.rds.amazonaws.com/app_test', 'MANAGED_PROVIDER');
  });

  test('refuse le schéma SRV vers un hôte ordinaire', () => {
    refuses('mongodb+srv://cluster.example.org/app_test', 'SRV_CLUSTER');
  });

  test('refuse tout ce qui évoque la production', () => {
    refuses('mongodb://localhost/scolaris_prod', 'PRODUCTION_NAME');
    refuses('mongodb://localhost/production', 'PRODUCTION_NAME');
    refuses('mongodb://mongo-prod:27017/app_test', 'PRODUCTION_NAME');
    refuses('postgres://u:p@prod.localhost/app', 'PRODUCTION_NAME');
  });

  test('un hôte distant est refusé sauf s’il est listé ET que la base est marquée test', () => {
    refuses('mongodb://db.client.example.org:27017/app_test', 'REMOTE_HOST');
    refuses('mongodb://203.0.113.9:27017/app_test', 'REMOTE_HOST');
    refuses('mongodb://10.0.0.5:27017/app_test', 'REMOTE_HOST');
    const allow = { allowRemoteHosts: ['ci-db.example.org'] };
    refuses('mongodb://ci-db.example.org:27017/scolaris', 'REMOTE_NOT_MARKED_TEST', allow);
    expect(isSafeTestDatabaseUri('mongodb://ci-db.example.org:27017/scolaris_test', { env: {}, ...allow })).toBe(true);
  });

  test('un hôte distant parmi plusieurs suffit à refuser', () => {
    refuses('mongodb://localhost:27017,db.client.example.org:27017/app_test', 'REMOTE_HOST');
  });

  test('refuse l’URI de l’environnement tant que la base n’est pas marquée test', () => {
    const env = { MONGODB_URI: 'mongodb://localhost:27017/scolaris' };
    refuses('mongodb://localhost:27017/scolaris', 'SAME_AS_CONFIGURED', { env });
    expect(isSafeTestDatabaseUri('mongodb://localhost:27017/scolaris_test', { env })).toBe(true);
  });

  test('refuse une URI illisible', () => {
    refuses('n’importe quoi', 'INVALID_URI');
    refuses('', 'INVALID_URI');
    refuses('redis://localhost:6379', 'INVALID_URI');
  });

  test('analyse l’URI', () => {
    expect(parseDatabaseUri('mongodb://u:p@a:1,b:2/db?x=1')).toEqual({ scheme: 'mongodb', engine: 'mongodb', hosts: ['a', 'b'], database: 'db' });
    expect(parseDatabaseUri('postgres://u@h/d').engine).toBe('postgres');
  });
});
