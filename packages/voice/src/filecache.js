'use strict';

const { mimeTypeForAudio } = require('./builders');

const DAY_MS = 86400000;

function assertFilesystem(filesystem) {
  if (!filesystem) throw new Error('createFileVoiceCache: filesystem is required.');
  for (const method of ['mkdir', 'readFile', 'writeFile', 'rename', 'remove', 'list', 'modifiedAt', 'touch']) {
    if (typeof filesystem[method] !== 'function') throw new Error(`createFileVoiceCache: filesystem.${method} must be a function.`);
  }
}

/**
 * A voice cache on disk: one finished file per reading, kept under its key.
 * A reading heard again is touched (its date moves, so it stays); one not
 * heard for `retainDays` is removed by `prune`, which a write runs by itself
 * at most every `pruneEveryMs`. A key is only what `keyPattern` accepts, so a
 * key can never name a path.
 *
 * @param {{ filesystem: { mkdir(dir: string): Promise<unknown>, readFile(path: string): Promise<Uint8Array>,
 *           writeFile(path: string, data: Uint8Array | string): Promise<unknown>, rename(from: string, to: string): Promise<unknown>,
 *           remove(path: string): Promise<unknown>, list(dir: string): Promise<string[]>,
 *           modifiedAt(path: string): Promise<number | null>, touch(path: string): Promise<unknown> },
 *           directory: string, extension?: string, keyPattern?: RegExp, retainDays?: number, pruneEveryMs?: number,
 *           now?: () => number, initialFiles?: Record<string, string> }} options
 *   `initialFiles`: files written beside the readings when the directory is made (a `.gitignore`, for one)
 */
function createFileVoiceCache({ filesystem, directory, extension = 'm4a', keyPattern = /^[\w-]{1,200}$/, retainDays = 60, pruneEveryMs = 6 * 60 * 60 * 1000, now = Date.now, initialFiles = {} } = {}) {
  assertFilesystem(filesystem);
  if (!directory) throw new Error('createFileVoiceCache: directory is required.');
  const pathOf = (key) => `${directory}/${key}.${extension}`;
  let prunedAt = 0;

  async function prune(at = now()) {
    let removed = 0;
    for (const name of await filesystem.list(directory).catch(() => [])) {
      if (!name.endsWith(`.${extension}`)) continue;
      const modified = await filesystem.modifiedAt(`${directory}/${name}`).catch(() => null);
      if (modified !== null && at - modified > retainDays * DAY_MS) {
        await filesystem.remove(`${directory}/${name}`);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    /** The reading kept under `key`, touched; null when there is none (or the key is not one). */
    async get(key) {
      if (!keyPattern.test(String(key))) return null;
      const audio = await filesystem.readFile(pathOf(key)).catch(() => null);
      if (!audio) return null;
      await filesystem.touch(pathOf(key)).catch(() => {});
      return { audio: Buffer.from(audio), format: extension, mimeType: mimeTypeForAudio(extension) };
    },
    /** Keeps a reading under `key` (written whole, then given its name). The time to live is the cache's own: `retainDays`. */
    async set(key, entry) {
      if (!keyPattern.test(String(key))) throw new Error('set: invalid key.');
      await filesystem.mkdir(directory);
      for (const [name, content] of Object.entries(initialFiles)) await filesystem.writeFile(`${directory}/${name}`, content);
      await filesystem.writeFile(`${pathOf(key)}.part`, entry.audio);
      await filesystem.rename(`${pathOf(key)}.part`, pathOf(key));
      if (now() - prunedAt >= pruneEveryMs) {
        prunedAt = now();
        prune().catch(() => {});
      }
    },
    async delete(key) {
      if (!keyPattern.test(String(key))) return false;
      await filesystem.remove(pathOf(key));
      return true;
    },
    /** Removes the readings not heard for `retainDays`; how many left. */
    prune
  };
}

module.exports = { createFileVoiceCache };
