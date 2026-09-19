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

module.exports = { createMemoryVoiceCache };
