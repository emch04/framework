'use strict';

/* global URLSearchParams */

const { spawnSync } = require('node:child_process');
const { assertSafeTestDatabaseUri, UnsafeTestDatabaseError } = require('./guard');

const MONGO_IMAGE = 'mongo:8';
const POSTGRES_IMAGE = 'postgres:17-alpine';
const DEFAULT_DATABASE = 'astratra_test';

function defaultLoader(name) {
  try {
    return require(name);
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw Object.assign(new Error(`${name} est requis pour démarrer un conteneur : npm install --save-dev ${name}`), { code: 'TESTCONTAINERS_MISSING' });
    }
    throw error;
  }
}

/** Vrai si un démon Docker répond (ou un runtime compatible : Podman, Colima…). */
function isDockerAvailable({ spawn = spawnSync } = {}) {
  try {
    const result = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 10_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function refuseInProduction(env) {
  if (env.NODE_ENV === 'production') {
    throw new UnsafeTestDatabaseError('NODE_ENV_PRODUCTION', 'NODE_ENV=production : aucun conteneur de test ne doit démarrer ici');
  }
}

/** Ajoute le nom de base et `directConnection` à l'URI du conteneur MongoDB (replica set à un nœud). */
function mongoUri(rawUri, database) {
  const [head, query] = rawUri.split('?');
  const params = new URLSearchParams(query || '');
  params.set('directConnection', 'true');
  return `${head.replace(/\/$/, '')}/${database}?${params.toString()}`;
}

function wrap(started, uri, engine, env) {
  // Seconde vérification, sur l'URI réellement obtenue : le conteneur doit être local.
  assertSafeTestDatabaseUri(uri, { env });
  let stopped = false;
  return {
    engine,
    uri,
    container: started,
    async stop() {
      if (stopped) return;
      stopped = true;
      await started.stop();
    }
  };
}

async function startMongo({ image = MONGO_IMAGE, database = DEFAULT_DATABASE, env = process.env, loader = defaultLoader } = {}) {
  refuseInProduction(env);
  const { MongoDBContainer } = loader('@testcontainers/mongodb');
  const started = await new MongoDBContainer(image).start();
  try {
    return wrap(started, mongoUri(started.getConnectionString(), database), 'mongodb', env);
  } catch (error) {
    await started.stop();
    throw error;
  }
}

async function startPostgres({ image = POSTGRES_IMAGE, database = DEFAULT_DATABASE, env = process.env, loader = defaultLoader } = {}) {
  refuseInProduction(env);
  const { PostgreSqlContainer } = loader('@testcontainers/postgresql');
  const started = await new PostgreSqlContainer(image).withDatabase(database).start();
  try {
    return wrap(started, started.getConnectionUri(), 'postgres', env);
  } catch (error) {
    await started.stop();
    throw error;
  }
}

module.exports = { MONGO_IMAGE, POSTGRES_IMAGE, isDockerAvailable, startMongo, startPostgres, mongoUri };
