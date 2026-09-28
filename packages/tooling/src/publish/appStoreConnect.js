/* global fetch */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ToolingError } = require('../errors');
const { runProcess } = require('../processRunner');
const { signJwt } = require('./jwt');

const ASC_API_BASE = 'https://api.appstoreconnect.apple.com';
const ASC_AUDIENCE = 'appstoreconnect-v1';
const MAX_TOKEN_TTL_SECONDS = 20 * 60;
const KEY_ID = /^[A-Z0-9]{8,12}$/;
const ISSUER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALTOOL_PLATFORMS = new Set(['ios', 'macos', 'appletvos', 'visionos']);

function expandHome(value, homeDir = os.homedir()) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value === '~') {
    return homeDir;
  }
  return value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value;
}

/** Where `xcrun altool --apiKey` itself looks for AuthKey_<id>.p8, in its own order. */
function defaultKeysDirs(homeDir = os.homedir(), cwd = process.cwd()) {
  return [
    path.join(cwd, 'private_keys'),
    path.join(homeDir, 'private_keys'),
    path.join(homeDir, '.private_keys'),
    path.join(homeDir, '.appstoreconnect', 'private_keys')
  ];
}

/**
 * Reads KEY=VALUE lines. The file is parsed, never sourced: a line like
 * `ASC_KEY_ID=$(curl ...)` is read as text, not run.
 */
function parseEnvFile(text) {
  const values = {};

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    values[match[1]] = value;
  }

  return values;
}

function readEnvFile(filePath) {
  return fs.existsSync(filePath) ? parseEnvFile(fs.readFileSync(filePath, 'utf8')) : null;
}

/**
 * Gathers the API key: its id and issuer (from the env file, else from the
 * process environment, under the configured variable names) and the .p8 path
 * (explicit, else AuthKey_<id>.p8 in the key directories).
 */
function loadAscCredentials(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const keyIdVar = options.keyIdEnv || 'ASC_KEY_ID';
  const issuerVar = options.issuerIdEnv || 'ASC_ISSUER_ID';
  const envFile = options.envFile ? expandHome(options.envFile, homeDir) : null;
  const fileValues = envFile ? readEnvFile(envFile) : null;

  if (envFile && !fileValues && !options.allowMissingEnvFile) {
    throw new ToolingError('ASC_CREDENTIALS_MISSING', `Fichier de cle App Store Connect introuvable : ${envFile}`, 400);
  }

  const keyId = (fileValues && fileValues[keyIdVar]) || env[keyIdVar];
  const issuerId = (fileValues && fileValues[issuerVar]) || env[issuerVar];

  if (!keyId || !issuerId) {
    throw new ToolingError('ASC_CREDENTIALS_MISSING', `Identifiants App Store Connect absents (${keyIdVar}, ${issuerVar}).`, 400);
  }
  if (!KEY_ID.test(keyId)) {
    throw new ToolingError('ASC_CREDENTIALS_INVALID', `${keyIdVar} n'a pas la forme d'un identifiant de cle Apple.`, 400);
  }
  if (!ISSUER_ID.test(issuerId)) {
    throw new ToolingError('ASC_CREDENTIALS_INVALID', `${issuerVar} n'a pas la forme d'un identifiant d'emetteur (UUID).`, 400);
  }

  let privateKeyPath = options.privateKeyPath ? expandHome(options.privateKeyPath, homeDir) : null;
  if (!privateKeyPath) {
    const dirs = (options.keysDirs || defaultKeysDirs(homeDir, options.cwd)).map((dir) => expandHome(dir, homeDir));
    const fileName = `AuthKey_${keyId}.p8`;
    const found = dirs.map((dir) => path.join(dir, fileName)).find((candidate) => fs.existsSync(candidate));
    if (!found) {
      throw new ToolingError('ASC_KEY_FILE_MISSING', `${fileName} introuvable dans : ${dirs.join(', ')}`, 400);
    }
    privateKeyPath = found;
  } else if (!fs.existsSync(privateKeyPath)) {
    throw new ToolingError('ASC_KEY_FILE_MISSING', `Cle .p8 introuvable : ${privateKeyPath}`, 400);
  }

  return { keyId, issuerId, privateKeyPath };
}

/** Same lookup, but answers yes/no: a missing key selects the Transporter fallback. */
function hasAscCredentials(options = {}) {
  try {
    loadAscCredentials(options);
    return true;
  } catch (error) {
    if (error && /^ASC_/.test(error.code || '')) {
      return false;
    }
    throw error;
  }
}

function createAscToken({ keyId, issuerId, privateKey, now = Date.now(), ttlSeconds = MAX_TOKEN_TTL_SECONDS }) {
  if (!(ttlSeconds > 0 && ttlSeconds <= MAX_TOKEN_TTL_SECONDS)) {
    throw new ToolingError('ASC_TOKEN_TTL_INVALID', `Apple refuse un jeton de plus de ${MAX_TOKEN_TTL_SECONDS} s.`, 400);
  }

  const issuedAt = Math.floor(now / 1000);
  return signJwt({
    algorithm: 'ES256',
    header: { kid: keyId },
    payload: { iss: issuerId, iat: issuedAt, exp: issuedAt + ttlSeconds, aud: ASC_AUDIENCE },
    privateKey
  });
}

/**
 * Proves the key works before a 20-minute build is spent on it: one signed
 * GET /v1/apps. With `bundleId`, also proves the app exists in this account.
 */
async function checkAscKey(options = {}) {
  const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
  const credentials = options.credentials;
  if (!credentials) {
    throw new ToolingError('ASC_CREDENTIALS_MISSING', 'Identifiants App Store Connect manquants.', 400);
  }

  const privateKey = options.privateKey || fs.readFileSync(credentials.privateKeyPath, 'utf8');
  const token = createAscToken({
    keyId: credentials.keyId,
    issuerId: credentials.issuerId,
    privateKey,
    now: options.now ? options.now() : Date.now()
  });

  const query = new URLSearchParamsLite({ limit: '1' });
  if (options.bundleId) {
    query.set('filter[bundleId]', options.bundleId);
  }
  const url = `${options.apiBase || ASC_API_BASE}/v1/apps?${query}`;

  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    throw new ToolingError('ASC_NETWORK', `App Store Connect injoignable (${error && error.code ? error.code : 'reseau'}).`, 502);
  }

  if (response.status === 401) {
    throw new ToolingError('ASC_KEY_REJECTED', 'Apple refuse la cle (401) : identifiant, emetteur ou fichier .p8 ne correspondent pas, ou la cle est revoquee.', 401);
  }
  if (response.status === 403) {
    throw new ToolingError('ASC_KEY_FORBIDDEN', 'La cle est reconnue mais son role ne permet pas de lire les apps (403).', 403);
  }
  if (!response.ok) {
    throw new ToolingError('ASC_CHECK_FAILED', `App Store Connect a repondu ${response.status}.`, response.status);
  }

  const body = await response.json().catch(() => ({}));
  const apps = Array.isArray(body && body.data) ? body.data : [];
  if (options.bundleId && apps.length === 0) {
    throw new ToolingError('ASC_APP_NOT_FOUND', `Aucune app ${options.bundleId} dans ce compte App Store Connect.`, 404);
  }

  return { ok: true, status: response.status, appCount: apps.length, appId: apps[0] ? apps[0].id : null };
}

/** Minimal ordered query builder (keeps `filter[bundleId]` readable in tests). */
class URLSearchParamsLite {
  constructor(initial = {}) {
    this.entries = Object.entries(initial);
  }

  set(key, value) {
    this.entries = this.entries.filter(([name]) => name !== key).concat([[key, value]]);
  }

  toString() {
    return this.entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  }
}

function buildAltoolCommand({ filePath, keyId, issuerId, privateKeyPath, platform = 'ios', outputFormat = 'normal' }) {
  if (!filePath) {
    throw new ToolingError('ASC_ARCHIVE_MISSING', 'Aucun fichier .ipa a envoyer.', 400);
  }
  if (!ALTOOL_PLATFORMS.has(platform)) {
    throw new ToolingError('ASC_PLATFORM_INVALID', `Plateforme altool inconnue : ${platform}`, 400);
  }
  if (!KEY_ID.test(String(keyId || '')) || !ISSUER_ID.test(String(issuerId || ''))) {
    throw new ToolingError('ASC_CREDENTIALS_INVALID', 'Identifiant de cle ou d\'emetteur invalide.', 400);
  }

  return {
    command: 'xcrun',
    args: [
      'altool', '--upload-app',
      '-f', filePath,
      '-t', platform,
      '--apiKey', keyId,
      '--apiIssuer', issuerId,
      '--output-format', outputFormat
    ],
    // altool finds AuthKey_<id>.p8 through this variable when it is not in its default folders.
    env: privateKeyPath ? { API_PRIVATE_KEYS_DIR: path.dirname(privateKeyPath) } : {}
  };
}

function redact(line, secrets) {
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('***'), line);
}

/**
 * Runs altool. A zero exit code is not enough: altool has been known to exit 0
 * while printing an ITMS error, so the output is checked too.
 */
async function uploadToAppStore(options = {}) {
  const { filePath, credentials } = options;
  const run = options.runProcess || runProcess;
  const output = options.onLine || (() => {});
  if (!fs.existsSync(filePath)) {
    throw new ToolingError('ASC_ARCHIVE_MISSING', `Fichier .ipa introuvable : ${filePath}`, 400);
  }

  const built = buildAltoolCommand({ ...credentials, filePath, platform: options.platform || 'ios' });
  const secrets = [credentials.issuerId, credentials.keyId];
  const result = await run(built.command, built.args, {
    cwd: options.cwd,
    env: { ...(options.env || process.env), ...built.env },
    onLine: (line) => output(redact(line, secrets))
  });

  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  const itms = /ERROR ITMS-(\d+)/.exec(combined);
  if (result.code !== 0 || itms) {
    throw new ToolingError(
      'ASC_UPLOAD_FAILED',
      `L'envoi a App Store Connect a echoue${itms ? ` (ITMS-${itms[1]})` : ''} (code ${result.code}).`,
      502
    );
  }

  return { ok: true };
}

module.exports = {
  ASC_AUDIENCE,
  MAX_TOKEN_TTL_SECONDS,
  buildAltoolCommand,
  checkAscKey,
  createAscToken,
  defaultKeysDirs,
  expandHome,
  hasAscCredentials,
  loadAscCredentials,
  parseEnvFile,
  uploadToAppStore
};
