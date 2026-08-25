/**
 * Small helpers shared across the package. Nothing here is Astratra-specific;
 * they exist so the modules below read the same way.
 */

/**
 * Fail at wiring time rather than at the first request. An adapter missing a
 * method is a mistake in the caller's setup, and the earlier it is named the
 * cheaper it is to fix.
 */
function assertAdapter(adapter, methods, name) {
  for (const method of methods) {
    if (!adapter || typeof adapter[method] !== 'function') {
      throw new Error(`Astratra credentials requires ${name}.${method}().`);
    }
  }
}

/**
 * Never show a secret in full: the last four characters are enough to
 * recognise a key, never enough to use it. A screenshot of the settings
 * screen must not compromise anything.
 */
function maskSecret(value) {
  if (!value) return null;
  const text = String(value);
  return text.length <= 4 ? '••••' : `••••${text.slice(-4)}`;
}

/**
 * Same idea for the address a one-time code was sent to: enough to confirm it
 * is the right inbox, not enough to learn an address you did not already know.
 */
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '•••';
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(3, name.length - 2))}@${domain}`;
}

module.exports = { assertAdapter, maskSecret, maskEmail };
