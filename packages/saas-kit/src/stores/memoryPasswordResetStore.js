/**
 * Reset tokens, kept as fingerprints.
 *
 * Same rule as refresh tokens: what is stored must not be usable. A leaked
 * table of reset tokens is a leaked table of accounts, and unlike a password
 * these need no cracking — they ARE the credential.
 *
 * Dev-only adapter: it lives in process memory, so a restart invalidates every
 * pending reset link.
 */
function createMemoryPasswordResetStore() {
  const byHash = new Map();

  return {
    async save(record) {
      byHash.set(record.hash, { ...record });
    },
    async find(hash) {
      const record = byHash.get(hash);
      return record ? { ...record } : null;
    },
    /** Single use: consuming DELETES, so a replay finds nothing at all. */
    async consume(hash) {
      const record = byHash.get(hash);
      byHash.delete(hash);
      return record ? { ...record } : null;
    },
    async deleteForUser(userId) {
      for (const [hash, record] of byHash) {
        if (record.userId === userId) byHash.delete(hash);
      }
    }
  };
}

module.exports = createMemoryPasswordResetStore;
