/**
 * Where the tokens live, and why the app must not care.
 *
 * On a phone a session belongs in the platform keystore — Keychain on iOS,
 * Keystore on Android. That is a NATIVE module: importing it in this package
 * would drag a native build into every test run, and would make the package
 * useless anywhere the module is absent — a browser preview, a Node test, a
 * development client compiled before the module was installed.
 *
 * So the keystore is INJECTED. Anything with the three async methods below
 * qualifies: expo-secure-store passes as-is, and the two adapters here cover
 * the cases where it cannot run.
 *
 * The contract is deliberately expo-secure-store's own, method names included.
 * Renaming it would have forced every caller to write a wrapper for the one
 * implementation everybody actually uses.
 */

/**
 * Tokens held for the lifetime of the process, nowhere else.
 *
 * For tests, and for the rare screen that must run before a keystore exists.
 * NOT a fallback to reach for in a shipped app: a session that lives only in
 * memory is gone at the next launch, and the person signs in again every time.
 */
function createMemoryKeystore() {
  const values = new Map();
  return {
    async getItemAsync(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async setItemAsync(key, value) {
      values.set(key, String(value));
    },
    async deleteItemAsync(key) {
      values.delete(key);
    }
  };
}

/**
 * The browser stand-in, for development previews only.
 *
 * expo-secure-store has no real web implementation, and `localStorage` is not
 * a keystore: any script on the page reads it. It is here so a preview can be
 * clicked through, never so a shipped web build can hold a session.
 *
 * @param {object|null} storage  localStorage, sessionStorage, or anything with
 *   getItem/setItem/removeItem. Null or absent is tolerated — a page with
 *   storage disabled must not crash on boot.
 */
function createWebKeystore(storage) {
  const backing = storage || null;
  return {
    async getItemAsync(key) {
      if (!backing) return null;
      try {
        const value = backing.getItem(key);
        return value === undefined ? null : value;
      } catch {
        return null;
      }
    },
    async setItemAsync(key, value) {
      if (!backing) return;
      try {
        backing.setItem(key, String(value));
      } catch {
        /* storage full or blocked: losing the session beats crashing */
      }
    },
    async deleteItemAsync(key) {
      if (!backing) return;
      try {
        backing.removeItem(key);
      } catch {
        /* same */
      }
    }
  };
}

module.exports = { createMemoryKeystore, createWebKeystore };
