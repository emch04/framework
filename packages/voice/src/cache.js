'use strict';

function copyEntry(entry) {
  if (!entry) return null;
  return {
    audio: Buffer.from(entry.audio),
    format: entry.format,
    mimeType: entry.mimeType
  };
}

/** A Buffer-safe cache for tests and single-process development. */
function createMemoryVoiceCache() {
  const entries = new Map();
  return {
    async get(key) {
      return copyEntry(entries.get(String(key)));
    },
    async set(key, entry, _ttlSeconds) {
      entries.set(String(key), copyEntry(entry));
    },
    async delete(key) {
      return entries.delete(String(key));
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    }
  };
}

const byteLength = (entry) => Buffer.byteLength(entry.audio);

/**
 * An in-process voice cache whose size is bounded, least recently used out
 * first: by number of readings (`maxEntries`), by bytes of audio (`maxBytes`),
 * or both. Reading a phrase again keeps it. With neither limit it holds 256
 * readings — a cache never grows without end by default.
 *
 * `set` honours the time to live the voice service passes (seconds; none or 0:
 * until evicted); an expired reading is a miss and is dropped. A reading bigger
 * than `maxBytes` is not kept. Same interface as createMemoryVoiceCache, so it
 * is a `cache` for createVoiceService and createProviderVoiceService.
 *
 * @param {{ maxEntries?: number, maxBytes?: number, now?: () => number }} [options]
 */
function createBoundedVoiceCache(options = {}) {
  const hasEntries = options.maxEntries !== undefined && options.maxEntries !== null;
  const hasBytes = options.maxBytes !== undefined && options.maxBytes !== null;
  const maxEntries = hasEntries ? options.maxEntries : (hasBytes ? Infinity : 256);
  const maxBytes = hasBytes ? options.maxBytes : Infinity;
  if (!(maxEntries >= 1)) throw new RangeError('createBoundedVoiceCache: maxEntries must be at least 1.');
  if (!(maxBytes >= 1)) throw new RangeError('createBoundedVoiceCache: maxBytes must be at least 1.');
  const now = options.now || Date.now;
  /* A Map keeps insertion order: the first key is the least recently used (a read re-inserts). */
  const entries = new Map();
  let bytes = 0;

  const drop = (key) => {
    const found = entries.get(key);
    if (!found) return false;
    bytes -= found.size;
    entries.delete(key);
    return true;
  };

  function evict() {
    while (entries.size > maxEntries || bytes > maxBytes) {
      drop(entries.keys().next().value);
    }
  }

  return {
    async get(key) {
      const id = String(key);
      const found = entries.get(id);
      if (!found) return null;
      if (found.expiresAt !== null && found.expiresAt <= now()) {
        drop(id);
        return null;
      }
      entries.delete(id);
      entries.set(id, found);
      return copyEntry(found.entry);
    },
    async set(key, entry, ttlSeconds) {
      const id = String(key);
      drop(id);
      const stored = copyEntry(entry);
      const size = byteLength(stored);
      if (size > maxBytes) return;
      const ttl = Number(ttlSeconds);
      entries.set(id, { entry: stored, size, expiresAt: ttl > 0 ? now() + ttl * 1000 : null });
      bytes += size;
      evict();
    },
    async delete(key) {
      return drop(String(key));
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    get size() {
      return entries.size;
    },
    /** Bytes of audio held. */
    get bytes() {
      return bytes;
    }
  };
}

module.exports = { createMemoryVoiceCache, createBoundedVoiceCache };
