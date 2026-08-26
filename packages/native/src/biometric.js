/**
 * Unlocking with a face or a finger — the state, not the screen.
 *
 * The original lived in a React hook, which made it untestable without a
 * renderer and unusable outside React. What actually matters is a small state
 * machine over two facts the device reports and one flag the person chose:
 *
 *   hardware  — the sensor exists;
 *   enrolled  — a face or finger is registered on the device;
 *   enabled   — this person asked for it, in this app.
 *
 * SUPPORTED IS BOTH DEVICE FACTS. A phone with a sensor and nothing enrolled
 * shows the prompt and refuses instantly, which reads to the user as a broken
 * feature. Offering the switch at all requires both.
 *
 * ENABLE PROMPTS FIRST, STORES SECOND. Storing the flag then prompting would
 * leave the app claiming an unlock the person never granted.
 *
 * NOTHING HERE THROWS. A sensor can be busy, a permission revoked between two
 * screens. The caller gets a result to display, never an exception to catch.
 */

const BIOMETRIC = 'biometric.enabled';

/**
 * @param {object} options
 * @param {object} options.keystore  Same contract as createSecureSession's.
 * @param {object} options.authenticator  hasHardwareAsync/isEnrolledAsync/
 *   authenticateAsync — expo-local-authentication passes as-is.
 * @param {string} [options.namespace='app']
 * @param {string} [options.promptMessage]  Default prompt title.
 */
function createBiometricGate(options = {}) {
  const keystore = options.keystore;
  const authenticator = options.authenticator;
  if (!keystore || typeof keystore.getItemAsync !== 'function') {
    throw new Error('createBiometricGate requires options.keystore.');
  }
  if (!authenticator || typeof authenticator.authenticateAsync !== 'function') {
    throw new Error('createBiometricGate requires options.authenticator with authenticateAsync.');
  }

  const key = `${options.namespace || 'app'}.${BIOMETRIC}`;
  const defaultPrompt = options.promptMessage || '';

  async function ask(fn) {
    try {
      return await fn();
    } catch {
      return false;
    }
  }

  /** The three facts, read together. Never throws. */
  async function read() {
    const [flag, hardware, enrolled] = await Promise.all([
      ask(() => keystore.getItemAsync(key)),
      ask(() => authenticator.hasHardwareAsync()),
      ask(() => authenticator.isEnrolledAsync())
    ]);
    const supported = Boolean(hardware) && Boolean(enrolled);
    return {
      enabled: flag === 'true' && supported,
      hardware: Boolean(hardware),
      enrolled: Boolean(enrolled),
      supported
    };
  }

  /**
   * Ask the person, then remember the answer.
   * @returns {Promise<{enabled: boolean, supported: boolean, failed: boolean}>}
   *   `failed` separates "the sensor errored" from "the person said no" — the
   *   first deserves a message, the second does not.
   */
  async function enable({ promptMessage } = {}) {
    const state = await read();
    if (!state.supported) return { enabled: false, supported: false, failed: false };

    let result;
    try {
      result = await authenticator.authenticateAsync({ promptMessage: promptMessage || defaultPrompt });
    } catch {
      return { enabled: false, supported: true, failed: true };
    }

    if (!result || !result.success) return { enabled: false, supported: true, failed: false };

    try {
      await keystore.setItemAsync(key, 'true');
    } catch {
      return { enabled: false, supported: true, failed: true };
    }
    return { enabled: true, supported: true, failed: false };
  }

  /** Turn it off. No prompt: refusing to disable would trap the person. */
  async function disable() {
    try {
      await keystore.deleteItemAsync(key);
    } catch {
      /* the flag is re-checked against the device on every read anyway */
    }
    return { enabled: false };
  }

  /**
   * Unlock now — the sign-in screen's Face ID button.
   * Answers false when the gate was never enabled, WITHOUT prompting: a prompt
   * nobody asked for is how an app gets reported for phishing a fingerprint.
   */
  async function confirm({ promptMessage } = {}) {
    const state = await read();
    if (!state.enabled) return false;
    try {
      const result = await authenticator.authenticateAsync({ promptMessage: promptMessage || defaultPrompt });
      return Boolean(result && result.success);
    } catch {
      return false;
    }
  }

  return { read, enable, disable, confirm, key };
}

module.exports = { createBiometricGate };
