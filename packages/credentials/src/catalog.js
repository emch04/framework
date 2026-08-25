/**
 * The list of keys the interface is allowed to manage.
 *
 * An explicit catalogue, never a free-text field: without it any environment
 * variable name could be written to the store and then read at startup — an
 * open door for anyone who obtains an admin account.
 *
 * Astratra ships no catalogue of its own. Which providers a product uses, and
 * what breaks without each key, is the product's business.
 */

const DEFAULT_RESERVED_KEYS = Object.freeze([]);

function normalizeEntry(entry, spaceId, seen) {
  if (!entry || typeof entry.key !== 'string' || !entry.key.trim()) {
    throw new Error('createCredentialCatalog requires every entry to have a non-empty key.');
  }
  const key = entry.key.trim();
  if (seen.has(key)) {
    throw new Error(`createCredentialCatalog received the key "${key}" twice.`);
  }
  seen.add(key);

  return {
    key,
    label: entry.label || key,
    /* A sender address or a public client id is not a secret: encrypting it
       buys nothing and stops the interface from showing it back. */
    secret: entry.secret !== false,
    help: entry.help || null,
    where: entry.where || null,
    placeholder: entry.placeholder || null,
    space: spaceId
  };
}

/**
 * @param {object} options
 * @param {Array}  options.spaces        groups of keys: { id, label, hint, keys: [...] }
 * @param {string[]} [options.reservedKeys]  names that must never reach the store.
 */
function createCredentialCatalog(options = {}) {
  const spaces = Array.isArray(options.spaces) ? options.spaces : [];
  if (!spaces.length) {
    throw new Error('createCredentialCatalog requires at least one space.');
  }

  const seen = new Set();
  const entries = new Map();
  const normalizedSpaces = spaces.map((space) => {
    if (!space || typeof space.id !== 'string' || !space.id.trim()) {
      throw new Error('createCredentialCatalog requires every space to have an id.');
    }
    const keys = (Array.isArray(space.keys) ? space.keys : []).map((entry) => {
      const normalized = normalizeEntry(entry, space.id, seen);
      entries.set(normalized.key, normalized);
      return normalized;
    });
    return { id: space.id, label: space.label || space.id, hint: space.hint || null, keys };
  });

  /* Keys that must never be stored alongside the others. Putting the master
     encryption key, the session secret or the database URL in the same table
     as the values they protect is leaving the lock inside the safe. */
  const reserved = new Set(options.reservedKeys || DEFAULT_RESERVED_KEYS);
  for (const key of reserved) {
    if (entries.has(key)) {
      throw new Error(`createCredentialCatalog lists "${key}" as both managed and reserved.`);
    }
  }

  return {
    spaces: normalizedSpaces,
    has: (key) => entries.has(key),
    describe: (key) => entries.get(key) || null,
    isReserved: (key) => reserved.has(key),
    /** Every managed key name, flat — what you hand to the env hydrator. */
    keys: () => [...entries.keys()],
    isSecret: (key) => (entries.get(key) || { secret: true }).secret
  };
}

module.exports = { createCredentialCatalog };
