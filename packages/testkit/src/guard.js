'use strict';

/**
 * Garde-fou : une suite de tests ne doit JAMAIS pouvoir se brancher sur une base
 * de production. Le test qui vide et remplit une collection est exactement le
 * geste qui détruit des données réelles si l'URI vient d'un .env copié.
 *
 * Règles (toutes refusent, la première rencontrée explique) :
 *  1. NODE_ENV=production ;
 *  2. hébergeur géré (Atlas, RDS, Supabase, Neon…) — même listé, jamais accepté ;
 *  3. schéma SRV (`mongodb+srv`), qui désigne un cluster distant ;
 *  4. mot « prod », « production » ou « live » dans l'hôte ou le nom de base ;
 *  5. hôte distant (ni boucle locale, ni `.test`/`.localhost`, ni nom de service
 *     sans point) : accepté seulement s'il est listé dans `allowRemoteHosts`
 *     ET que le nom de la base est marqué test (`app_test`, `e2e`…) ;
 *  6. URI identique à celle configurée dans l'environnement (MONGODB_URI,
 *     DATABASE_URL…) sans nom de base marqué test.
 */

class UnsafeTestDatabaseError extends Error {
  constructor(reason, detail) {
    super(`UNSAFE_TEST_DATABASE: ${detail}`);
    this.name = 'UnsafeTestDatabaseError';
    this.code = 'UNSAFE_TEST_DATABASE';
    this.reason = reason;
  }
}

const MANAGED_HOSTS = [
  'mongodb.net', 'mongodb.com', 'rds.amazonaws.com', 'docdb.amazonaws.com', 'cosmos.azure.com',
  'postgres.database.azure.com', 'supabase.co', 'supabase.com', 'neon.tech', 'render.com',
  'railway.app', 'herokuapp.com', 'elephantsql.com', 'cockroachlabs.cloud', 'aivencloud.com',
  'digitalocean.com', 'ondigitalocean.com', 'cloud.timescale.com', 'tsdb.cloud.timescale.com'
];
const PROD_WORD = /(^|[^a-z0-9])(prod|production|live)([^a-z0-9]|$)/i;
const TEST_WORD = /(^|[^a-z0-9])(test|tests|testing|e2e|ci)([^a-z0-9]|$)/i;
const CONFIGURED_URI_VARIABLES = ['MONGODB_URI', 'MONGO_URL', 'MONGO_URI', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URI'];
const URI_PATTERN = /^(mongodb(?:\+srv)?|postgres(?:ql)?):\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i;

function splitHost(entry) {
  const host = entry.startsWith('[') ? entry.slice(1, entry.indexOf(']')) : entry.replace(/:\d+$/, '');
  return host.toLowerCase();
}

function isLocalHost(host) {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
    || host.endsWith('.localhost') || host.endsWith('.test')
    // Un nom sans point est un service de composition (« mongo », « db »), pas Internet.
    || (!host.includes('.') && !host.includes(':'));
}

function parseDatabaseUri(uri) {
  const match = URI_PATTERN.exec(String(uri ?? '').trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  return {
    scheme,
    engine: scheme.startsWith('mongodb') ? 'mongodb' : 'postgres',
    hosts: match[2].split(',').map(splitHost).filter(Boolean),
    database: match[3] ? decodeURIComponent(match[3]) : ''
  };
}

function assertSafeTestDatabaseUri(uri, { env = process.env, allowRemoteHosts = [] } = {}) {
  if (env.NODE_ENV === 'production') {
    throw new UnsafeTestDatabaseError('NODE_ENV_PRODUCTION', 'NODE_ENV=production : aucun test ne doit tourner ici');
  }
  const info = parseDatabaseUri(uri);
  if (!info || !info.hosts.length) throw new UnsafeTestDatabaseError('INVALID_URI', 'URI de base illisible');

  const managed = info.hosts.find((host) => MANAGED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)));
  if (managed) throw new UnsafeTestDatabaseError('MANAGED_PROVIDER', `hôte d'une base hébergée refusé (${managed})`);
  if (info.scheme === 'mongodb+srv') throw new UnsafeTestDatabaseError('SRV_CLUSTER', 'schéma mongodb+srv : cluster distant refusé');

  const prodHost = info.hosts.find((host) => PROD_WORD.test(host));
  if (prodHost || PROD_WORD.test(info.database)) {
    throw new UnsafeTestDatabaseError('PRODUCTION_NAME', 'nom d\'hôte ou de base qui évoque la production');
  }

  const testNamed = TEST_WORD.test(info.database);
  const allowed = allowRemoteHosts.map((host) => String(host).toLowerCase());
  const remote = info.hosts.filter((host) => !isLocalHost(host));
  for (const host of remote) {
    if (!allowed.includes(host)) throw new UnsafeTestDatabaseError('REMOTE_HOST', `hôte distant non autorisé (${host})`);
    if (!testNamed) throw new UnsafeTestDatabaseError('REMOTE_NOT_MARKED_TEST', `hôte distant ${host} : le nom de la base doit contenir « test »`);
  }

  const configured = CONFIGURED_URI_VARIABLES.map((name) => env[name]).filter(Boolean);
  if (!testNamed && configured.includes(String(uri).trim())) {
    throw new UnsafeTestDatabaseError('SAME_AS_CONFIGURED', 'URI identique à celle de l\'environnement, sans nom de base marqué test');
  }
  return info;
}

function isSafeTestDatabaseUri(uri, options) {
  try {
    assertSafeTestDatabaseUri(uri, options);
    return true;
  } catch (error) {
    if (error instanceof UnsafeTestDatabaseError) return false;
    throw error;
  }
}

module.exports = { UnsafeTestDatabaseError, parseDatabaseUri, assertSafeTestDatabaseUri, isSafeTestDatabaseUri };
