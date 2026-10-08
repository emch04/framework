/**
 * Service keys, encrypted in a store instead of a .env file.
 *
 * Changing a payment or mail provider key used to mean opening an SSH session,
 * editing a file and restarting the service. Three chances to get it wrong, and
 * a secret sitting in plaintext on the server's disk.
 *
 * Here a value arrives encrypted and never leaves towards a browser: the
 * interface only ever sees the last four characters. The environment keeps its
 * role as the fallback, so nothing breaks before a key has been entered.
 *
 * The order never changes:
 *
 *   1. a value entered through the interface → decrypted and used;
 *   2. a key explicitly disconnected         → nothing, even if the env has one;
 *   3. nothing stored                        → the environment, as before.
 *
 * Point two is the trap. Without a disconnect marker, deleting a key would let
 * the fallback environment variable bring it straight back — and you would
 * never know whether a service is really unplugged.
 *
 * By default nothing here throws on a read. No store, no cipher, a corrupted value: it
 * falls back to the environment. A payment must not fail because the database
 * hiccuped.
 */
const AppError = require('@astratra/core').AppError;
const { assertAdapter, maskSecret } = require('./utils');
const { createPermissiveGuard } = require('./valueGuard');
const { normalizeScope, sameScope, rowContext, versionMetadata } = require('./context');

/** Written in place of a value to mean "deliberately unplugged". */
const DISCONNECTED = '__disconnected__';

const NOOP_LOGGER = { warn() {}, error() {} };

/**
 * @param {object} options
 * @param {object} options.store    credential store adapter (findAll, upsert).
 * @param {object} options.catalog  from createCredentialCatalog().
 * @param {object} options.cipher   { encrypt, decrypt } — e.g. createFieldCipher().
 * @param {object} [options.previousCipher] the generation being retired, for
 *   the duration of a rotation. See createCredentialRotation().
 * @param {object} [options.guard]  from createValueGuard(). Permissive by default.
 * @param {object} [options.env]    defaults to process.env.
 * @param {number} [options.cacheMs] how long a read stays cached. Default 60000.
 * @param {Function} [options.now]  () => epoch ms, for tests.
 * @param {object} [options.logger] { warn, error }.
 * @param {Function} [options.onChange] called after a successful set/disconnect.
 */
function createCredentialVault(options = {}) {
  const scope = normalizeScope(options.scope);
  const strict = options.strict === true;
  const fallback = options.fallback === undefined ? 'env' : options.fallback;
  if (!['env', 'none'].includes(fallback)) throw new Error('Invalid credential fallback.');
  const store = options.store;
  if (scope && !store?.supportsScopes) throw new Error('The store must support credential scopes.');
  if (options.history && !['appendVersion', 'findVersion', 'listVersions', 'purgeVersions'].every(method => typeof store?.[method] === 'function')) throw new Error('History requires a versioned store.');
  const retentionMs = options.retentionMs === undefined ? 30 * 86400_000 : options.retentionMs;
  if (!Number.isFinite(retentionMs) || retentionMs < 0) throw new Error('Invalid retentionMs.');
  assertAdapter(store, ['findAll', 'upsert'], 'options.store');

  const catalog = options.catalog;
  if (!catalog || typeof catalog.has !== 'function') {
    throw new Error('createCredentialVault requires options.catalog from createCredentialCatalog().');
  }

  const cipher = options.cipher;
  if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') {
    throw new Error('createCredentialVault requires options.cipher with encrypt() and decrypt().');
  }

  /*
   * The generation being retired, present only while a rotation runs.
   *
   * Swapping the cipher in one go would make every stored key unreadable at
   * once — and silently, since a failed decrypt here is caught per row and the
   * environment quietly takes over. Reading both generations is what lets a
   * rotation happen without an outage: values migrate one by one, and the old
   * cipher is dropped once nothing needs it.
   *
   * WRITES always use the current cipher. That is what makes the rotation
   * converge instead of ping-ponging between generations.
   */
  const previousCipher = options.previousCipher || null;
  if (previousCipher && typeof previousCipher.decrypt !== 'function') {
    throw new Error('createCredentialVault requires options.previousCipher to expose decrypt().');
  }

  /** Decrypt with the current generation, falling back to the retiring one. */
  function decryptStored(value, row) {
    try {
      return cipher.decrypt(value, rowContext(row, scope));
    } catch {
      if (!previousCipher) throw new Error('Credential decryption refused.');
      return previousCipher.decrypt(value, rowContext(row, scope));
    }
  }

  const guard = options.guard || createPermissiveGuard();
  const env = options.env || process.env;
  const cacheMs = options.cacheMs === undefined ? 60_000 : options.cacheMs;
  const now = options.now || (() => Date.now());
  const logger = options.logger || NOOP_LOGGER;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;

  const onWrite = options.onWrite;
  if (onWrite !== undefined && typeof onWrite !== 'function') throw new Error('Invalid onWrite.');
  if (!Number.isFinite(cacheMs) || cacheMs < 0) throw new Error('Invalid cacheMs.');
  function readFailure(kind) {
    logger[kind === 'store' ? 'warn' : 'error']?.(`[credentials] ${kind} unreadable`);
    if (strict) {
      const error = new Error(`Credential ${kind} read failed.`);
      error.code = kind === 'store' ? 'CREDENTIAL_STORE_UNREADABLE' : 'CREDENTIAL_VALUE_UNREADABLE';
      throw error;
    }
  }
  let generation = 0;
  let cache = null;
  let cachedAt = 0;

  /** Everything in the store, decrypted, held in memory for `cacheMs`. */
  async function load() {
    if (cache && now() - cachedAt < cacheMs) return cache;

    const started = generation;
    let rows;
    try {
      rows = await store.findAll(scope || undefined, { strict });
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row.key !== 'string' || typeof row.value !== 'string' || (scope && !sameScope(row, scope)))) throw new Error();
    } catch {
      readFailure('store');
      return cache || new Map();
    }

    const next = new Map();
    for (const row of rows || []) {
      if (row.value === DISCONNECTED) {
        next.set(row.key, null);
        continue;
      }
      try {
        next.set(row.key, catalog.isSecret(row.key) ? decryptStored(row.value, row) : row.value);
      } catch {
        /* One unreadable key — rotated cipher, corrupted value — must not take
           the other nineteen down with it. It simply falls back to the env. */
        readFailure('value');
      }
    }

    if (started !== generation) return load();
    cache = next;
    cachedAt = now();
    return cache;
  }

  function readable(name, stored) {
    return guard.mayRead(name, {
      value: stored.get(name),
      decidingValue: guard.decidingKey ? stored.get(guard.decidingKey) : undefined
    });
  }

  function fromEnv(name) {
    return fallback === 'none' ? null : env[name] || null;
  }

  /** The value of one key — store first, environment next, null if unplugged. */
  async function get(name, readOptions = {}) {
    if (readOptions.version !== undefined) {
      if (!options.history) throw new Error('History is not enabled.');
      if (!Number.isSafeInteger(readOptions.version) || readOptions.version < 1) throw new Error('Invalid version.');
      let row;
      try { row = await store.findVersion(name, readOptions.version, scope || undefined); }
      catch { readFailure('store'); return null; }
      if (!row || row.purged || (row.expiresAt && new Date(row.expiresAt).getTime() <= now())) return null;
      const stored = await load();
      let value;
      try { value = row.value === DISCONNECTED ? null : catalog.isSecret(name) ? decryptStored(row.value, row) : row.value; }
      catch { readFailure('value'); return null; }
      return guard.mayRead(name, { value, decidingValue: stored.get(guard.decidingKey) }) ? value : null;
    }
    const stored = await load();
    if (stored.has(name) && readable(name, stored)) return stored.get(name);
    return fromEnv(name);
  }

  /** Several keys at once, without re-reading the store for each. */
  async function getMany(names) {
    const stored = await load();
    const out = {};
    for (const name of names || []) {
      out[name] = stored.has(name) && readable(name, stored) ? stored.get(name) : fromEnv(name);
    }
    return out;
  }

  /**
   * What the STORE says, with no environment fallback.
   *
   * A key absent from the store is absent from this map; a disconnected key is
   * present with `null`. `get()` erases that distinction — the env hydrator
   * cannot work without it.
   */
  async function stored() {
    return new Map(await load());
  }

  /** Forget the cache: after a write, the new value must serve immediately. */
  function forget() {
    generation += 1;
    cache = null;
    cachedAt = 0;
  }

  function assertWritable(name, value) {
    if (catalog.isReserved(name)) {
      throw new AppError(
        'This key cannot be stored here: it protects the others and stays on the server.',
        400
      );
    }
    if (!catalog.has(name)) {
      throw new AppError('This key is not recognised.', 400);
    }
    /* A development machine and production share one store: without this guard
       a value pasted from a laptop would be live in production within a
       minute. The judgement is on the value, not on the environment alone. */
    const permission = guard.mayWrite(name, value);
    if (!permission.ok) throw new AppError(permission.reason, 403);
  }

  /** Store a value entered through the interface. */
  async function set(name, value, meta = {}) {
    const clean = String(value === undefined || value === null ? '' : value).trim();
    assertWritable(name, clean);
    if (!clean) throw new AppError('Provide a value.', 400);

    await write(name, clean, meta, 'set');
  }

  async function write(name, value, meta, action) {
    const secret = catalog.isSecret(name);
    const build = (version) => ({
      key: name, ...(scope || {}), ...(version === undefined ? {} : { version }),
      value: action === 'disconnect' ? DISCONNECTED : secret
        ? cipher.encrypt(value, rowContext({ key: name, version }, scope)) : value,
      secret, updatedBy: meta.updatedBy || null, updatedAt: new Date(now())
    });
    let row;
    try {
      if (options.history) row = await store.appendVersion(name, scope || undefined, build, retentionMs);
      else { row = build(); await store.upsert(row); }
    } catch {
      throw new Error('Credential write failed.');
    }
    forget();
    const event = { ...versionMetadata(row), action };
    if (onWrite) {
      try { await onWrite(event); }
      catch {
        const error = new Error('Credential written, but onWrite failed.');
        error.code = 'CREDENTIAL_AFTER_WRITE_FAILED';
        error.committed = true;
        throw error;
      }
    }
    if (onChange) await onChange({ key: name, action });
  }

  /** Unplug a key — the environment does NOT take over. */
  async function disconnect(name, meta = {}) {
    assertWritable(name, await get(name));
    await write(name, null, meta, 'disconnect');
  }

  async function listVersions(name) {
    if (!options.history) throw new Error('History is not enabled.');
    try {
      const rows = await store.listVersions(name, scope || undefined);
      return rows.map(versionMetadata);
    } catch {
      readFailure('store');
      return [];
    }
  }

  async function purgeVersions() {
    if (!options.history) throw new Error('History is not enabled.');
    const count = await store.purgeVersions(new Date(now()), scope || undefined);
    forget();
    return count;
  }

  /**
   * The state of every managed key, safe to send to a browser.
   *
   * One rule holds the whole thing together: a secret value goes in and never
   * comes back out. What is returned says whether a key is in place, where it
   * comes from and how it ends — enough to recognise it, never enough to use
   * it. A screenshot of this screen must compromise nothing.
   */
  async function status() {
    let rows = [];
    try {
      rows = await store.findAll(scope || undefined, { strict });
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row.key !== 'string' || typeof row.value !== 'string' || (scope && !sameScope(row, scope)))) throw new Error();
    } catch {
      readFailure('store');
      rows = [];
    }
    const byKey = new Map(rows.map((row) => [row.key, row]));

    const spaces = catalog.spaces.map((space) => ({
      id: space.id,
      label: space.label,
      hint: space.hint,
      keys: space.keys.map((entry) => {
        const row = byKey.get(entry.key);
        const disconnected = row?.value === DISCONNECTED;
        const inStore = Boolean(row) && !disconnected;
        const inEnv = fallback === 'env' && Boolean(env[entry.key]);

        let preview = null;
        if (inStore) {
          try {
            const value = entry.secret ? decryptStored(row.value, row) : row.value;
            preview = entry.secret ? maskSecret(value) : value;
          } catch {
            readFailure('value');
          }
        } else if (inEnv) {
          preview = entry.secret ? maskSecret(env[entry.key]) : env[entry.key];
        }

        /* Locked by the environment: saying so up front beats letting someone
           type a value only to have it refused on save. */
        const permission = typeof guard.restrictsHere === 'function'
          ? guard.restrictsHere(entry.key)
          : { ok: true };

        return {
          key: entry.key,
          label: entry.label,
          help: entry.help,
          where: entry.where,
          placeholder: entry.placeholder,
          secret: entry.secret,
          readOnly: !permission.ok,
          readOnlyReason: permission.ok ? null : permission.reason,
          configured: inStore || (inEnv && !disconnected),
          source: disconnected ? 'disconnected' : inStore ? 'interface' : inEnv ? 'environment' : 'absent',
          preview,
          updatedAt: inStore ? row.updatedAt || null : null
        };
      })
    }));

    return { spaces };
  }

  /** Is a rotation in progress? */
  const isRotating = () => Boolean(previousCipher);

  return {
    scope, get, getMany, stored, set, disconnect, forget, status,
    listVersions, purgeVersions,
    isRotating, mask: maskSecret, DISCONNECTED,
  };
}

module.exports = { createCredentialVault, DISCONNECTED };
