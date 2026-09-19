/**
 * Media kept on the phone: fetched once, replayed from disk, bounded.
 *
 * The first version of this cache re-downloaded the WHOLE file on every play,
 * and left each copy behind under a timestamped name that nothing ever read
 * again: the cache directory grew without end. Something already played must
 * replay from disk, instantly and without network, and the directory must stay
 * bounded.
 *
 * Three pieces: a stable name for a piece of content (contentKey), the rule
 * for what to throw away (planEviction), and the gestures on disk
 * (createMediaCache). The file system is INJECTED — expo-file-system's legacy
 * API fits as-is — so all three run in plain Node.
 */

const MEDIA_CACHE_MAX_FILES = 40;
const MEDIA_CACHE_MAX_BYTES = 60 * 1024 * 1024;

/* A temporary file older than this is the remains of an interrupted download
   (app killed, network lost): nobody will finish it. Younger, it may still be
   being written — it is left alone. */
const MEDIA_CACHE_ABANDONED_MS = 5 * 60 * 1000;

const TEMP_SUFFIX = '.tmp';

/* cyrb53: a 53-bit pure-JS hash, stable across devices. Run twice with two
   seeds (106 bits): two different contents landing on the same name would
   serve the wrong media, and at that width it does not happen in practice.
   A platform crypto digest would be asynchronous and native — it does not run
   in Node, where this rule is tested. */
function cyrb53(text, seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (2097152 * (h2 >>> 0) + (h1 >>> 0)).toString(36);
}

/**
 * The file name of a piece of content: every part that changes the bytes.
 *
 * Put a version in the parts. When the server changes how it renders (a new
 * voice, a new codec), files kept under the old key must stop being served,
 * and bumping the version is how they do.
 *
 * The parts are encoded as a JSON array, never joined with a separator:
 * ('a:b', 'c') and ('a', 'b:c') must not share a key.
 *
 * @param {...(string|number|null|undefined)} parts  Null and undefined count
 *   as empty.
 * @returns {string}  [a-z0-9-] only — safe as a file name everywhere.
 */
function contentKey(...parts) {
  const source = JSON.stringify(parts.map((part) => (part === null || part === undefined ? '' : String(part))));
  return `${cyrb53(source, 1)}-${cyrb53(source, 2)}`;
}

/**
 * The extension to store a response under, from its Content-Type.
 * @param {string|null|undefined} contentType
 * @param {Record<string, string>} types  Lowercase MIME type => extension.
 * @param {string} fallback  For anything unlisted — including a missing header.
 */
function extensionFor(contentType, types, fallback) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const map = types || {};
  return Object.prototype.hasOwnProperty.call(map, type) ? map[type] : fallback;
}

function isFinished(name, extensions) {
  return extensions.some((extension) => name.endsWith(`.${extension}`));
}

/**
 * Which files to delete, least recently written first.
 *
 * - a finished file survives while the directory stays under maxFiles AND
 *   maxBytes; past either, the oldest go;
 * - the newest is NEVER deleted, even when too heavy on its own: it is the one
 *   being played;
 * - anything that is not a finished file (a temporary) goes once abandoned,
 *   and does not count against the bounds.
 *
 * @param {Array<{name: string, size: number, modifiedAt: number}>} files
 *   `modifiedAt` in milliseconds.
 * @param {object} options
 * @param {string[]} options.extensions  What a finished file ends with.
 * @param {number} [options.maxFiles]
 * @param {number} [options.maxBytes]
 * @param {number} [options.abandonedAfterMs]
 * @param {number} [options.now]
 * @returns {string[]}
 */
function planEviction(files, options = {}) {
  const extensions = Array.isArray(options.extensions) ? options.extensions : [];
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : MEDIA_CACHE_MAX_FILES;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MEDIA_CACHE_MAX_BYTES;
  const abandonedAfterMs = Number.isFinite(options.abandonedAfterMs) ? options.abandonedAfterMs : MEDIA_CACHE_ABANDONED_MS;
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const discard = [];
  const finished = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.name !== 'string') continue;
    if (isFinished(file.name, extensions)) finished.push(file);
    else if (now - file.modifiedAt > abandonedAfterMs) discard.push(file.name);
  }
  finished.sort((a, b) => b.modifiedAt - a.modifiedAt);
  let bytes = 0;
  finished.forEach((file, rank) => {
    bytes += Math.max(0, Number(file.size) || 0);
    if (rank === 0) return;
    if (rank >= maxFiles || bytes > maxBytes) discard.push(file.name);
  });
  return discard;
}

/**
 * The cache on disk.
 *
 * @param {object} options
 * @param {object} options.fs  expo-file-system/legacy's shape: getInfoAsync,
 *   makeDirectoryAsync, moveAsync, deleteAsync, readDirectoryAsync.
 *   getInfoAsync's `modificationTime` is in SECONDS, as Expo reports it.
 * @param {string} options.directory  A directory of its own — anything else
 *   found in it is treated as an abandoned temporary and deleted.
 * @param {string[]} options.extensions  Every extension a finished file may
 *   carry. A lookup tries each.
 * @param {number} [options.maxFiles]
 * @param {number} [options.maxBytes]
 * @param {number} [options.abandonedAfterMs]
 * @param {() => number} [options.now]
 */
function createMediaCache(options = {}) {
  const fs = options.fs;
  if (!fs) throw new Error('createMediaCache: an fs adapter is required.');
  if (!options.directory) throw new Error('createMediaCache: a directory is required.');
  const extensions = Array.isArray(options.extensions) ? options.extensions.filter(Boolean) : [];
  if (extensions.length === 0) throw new Error('createMediaCache: at least one extension is required.');
  const directory = options.directory.endsWith('/') ? options.directory : `${options.directory}/`;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const bounds = {
    extensions,
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    abandonedAfterMs: options.abandonedAfterMs
  };

  let tempCounter = 0;
  let tidying = null;

  /**
   * The finished file for a key, or null.
   *
   * No "last used" date is refreshed on a hit: the legacy API cannot touch a
   * file's date without rewriting it. Eviction therefore follows download
   * order — a file replayed often eventually goes, and comes back on the next
   * play.
   */
  async function lookup(key) {
    for (const extension of extensions) {
      const uri = `${directory}${key}.${extension}`;
      const info = await fs.getInfoAsync(uri);
      if (info && info.exists) return uri;
    }
    return null;
  }

  /**
   * Write under a temporary name, THEN move: an interruption mid-write leaves
   * a .tmp that eviction collects, never a truncated file taken for valid on
   * the next play.
   *
   * @param {string} key
   * @param {string} extension  One of `extensions`.
   * @param {(tempUri: string) => Promise<unknown>} write  Puts the bytes at
   *   tempUri, however the caller's platform writes bytes.
   * @returns {Promise<string>}  The finished file's URI.
   */
  async function store(key, extension, write) {
    if (!extensions.includes(extension)) {
      throw new Error(`createMediaCache: extension "${extension}" is not one of this cache's extensions.`);
    }
    await fs.makeDirectoryAsync(directory, { intermediates: true });
    const destination = `${directory}${key}.${extension}`;
    tempCounter += 1;
    const temporary = `${directory}${key}.${now()}-${tempCounter}${TEMP_SUFFIX}`;
    try {
      await write(temporary);
    } catch (error) {
      await fs.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
      throw error;
    }
    try {
      await fs.moveAsync({ from: temporary, to: destination });
    } catch (error) {
      /* Two taps on the same content: the other download already put the
         finished file in place. Ours is useless, theirs is valid. */
      await fs.deleteAsync(temporary, { idempotent: true });
      const info = await fs.getInfoAsync(destination);
      if (!info || !info.exists) throw error;
    }
    /* Tidying does not hold up playback: it runs on its own, and its failure
       concerns nobody. */
    void tidy().catch(() => undefined);
    return destination;
  }

  /**
   * The cached file, or a fresh download stored first.
   * @param {string} key
   * @param {() => Promise<{extension: string, write: (tempUri: string) => Promise<unknown>}>} download
   */
  async function resolve(key, download) {
    const known = await lookup(key);
    if (known) return known;
    const { extension, write } = await download();
    return store(key, extension, write);
  }

  /* One tidy at a time: two plays close together must not delete the same
     files twice. */
  function tidy() {
    if (tidying) return tidying;
    tidying = (async () => {
      const info = await fs.getInfoAsync(directory);
      if (!info || !info.exists) return [];
      const names = await fs.readDirectoryAsync(directory);
      const files = [];
      for (const name of names) {
        const entry = await fs.getInfoAsync(`${directory}${name}`);
        if (!entry || !entry.exists || entry.isDirectory) continue;
        files.push({ name, size: Number(entry.size) || 0, modifiedAt: (Number(entry.modificationTime) || 0) * 1000 });
      }
      const discard = planEviction(files, { ...bounds, now: now() });
      for (const name of discard) {
        await fs.deleteAsync(`${directory}${name}`, { idempotent: true });
      }
      return discard;
    })().finally(() => {
      tidying = null;
    });
    return tidying;
  }

  return { directory, lookup, store, resolve, tidy };
}

module.exports = {
  MEDIA_CACHE_MAX_FILES,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_CACHE_ABANDONED_MS,
  contentKey,
  extensionFor,
  planEviction,
  createMediaCache
};
