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
 * Nothing here throws on a read. No store, no cipher, a corrupted value: it
 * falls back to the environment. A payment must not fail because the database
 * hiccuped.
 */
const AppError = require('@astratra/core').AppError;
const { assertAdapter, maskSecret } = require('./utils');
const { createPermissiveGuard } = require('./valueGuard');

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
  const store = options.store;
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
  function decryptStored(value) {
    try {
      return cipher.decrypt(value);
    } catch (error) {
      if (!previousCipher) throw error;
      return previousCipher.decrypt(value);
    }
  }

  const guard = options.guard || createPermissiveGuard();
  const env = options.env || process.env;
  const cacheMs = options.cacheMs === undefined ? 60_000 : options.cacheMs;
  const now = options.now || (() => Date.now());
  const logger = options.logger || NOOP_LOGGER;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;

  let cache = null;
  let cachedAt = 0;

  /** Everything in the store, decrypted, held in memory for `cacheMs`. */
  async function load() {
    if (cache && now() - cachedAt < cacheMs) return cache;

    let rows;
    try {
      rows = await store.findAll();
    } catch (error) {
      logger.warn(`[credentials] store unreadable: ${error.message}`);
      return cache || new Map();
    }

    const next = new Map();
    for (const row of rows || []) {
      if (row.value === DISCONNECTED) {
        next.set(row.key, null);
        continue;
      }
      try {
        next.set(row.key, catalog.isSecret(row.key) ? decryptStored(row.value) : row.value);
      } catch (error) {
        /* One unreadable key — rotated cipher, corrupted value — must not take
           the other nineteen down with it. It simply falls back to the env. */
        logger.error(`[credentials] ${row.key} unreadable: ${error.message}`);
      }
    }

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
    return env[name] || null;
  }

  /** The value of one key — store first, environment next, null if unplugged. */
  async function get(name) {
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

    const secret = catalog.isSecret(name);
    await store.upsert({
      key: name,
      value: secret ? cipher.encrypt(clean) : clean,
      secret,
      updatedBy: meta.updatedBy || null,
      updatedAt: new Date()
    });
    forget();
    if (onChange) await onChange({ key: name, action: 'set' });
  }

  /** Unplug a key — the environment does NOT take over. */
  async function disconnect(name, meta = {}) {
    /* Unplugging carries no value to judge, but it is as consequential as
       plugging in: unplugging a live payment key from a laptop would take
       production down just as effectively. */
    assertWritable(name, await get(name));
    await store.upsert({
      key: name,
      value: DISCONNECTED,
      secret: catalog.isSecret(name),
      updatedBy: meta.updatedBy || null,
      updatedAt: new Date()
    });
    forget();
    if (onChange) await onChange({ key: name, action: 'disconnect' });
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
      rows = (await store.findAll()) || [];
    } catch (error) {
      logger.warn(`[credentials] status read failed: ${error.message}`);
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
        const inEnv = Boolean(env[entry.key]);

        let preview = null;
        if (inStore) {
          try {
            const value = entry.secret ? decryptStored(row.value) : row.value;
            preview = entry.secret ? maskSecret(value) : value;
          } catch (error) {
            logger.error(`[credentials] ${entry.key} unreadable: ${error.message}`);
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
    get, getMany, stored, set, disconnect, forget, status,
    isRotating, mask: maskSecret, DISCONNECTED,
  };
}

module.exports = { createCredentialVault, DISCONNECTED };
