/**
 * Sending someone out to pay, and getting them back.
 *
 * Two failures hide behind one innocent-looking call.
 *
 * THE NATIVE MODULE MAY NOT BE THERE. An in-app browser is a native module: a
 * development client built before it was installed does not contain it, and
 * merely importing it throws — an error a `try` catches while the red screen
 * shows it anyway. So the module is LOADED THROUGH AN INJECTED FUNCTION, and
 * its absence is an expected case, not an incident.
 *
 * THE GATEWAY RETURNS TO THE WEB, NOT TO THE APP. Payment done, the person sat
 * stranded on a web page with their purchase somewhere behind it. Handing the
 * browser a return link — the app's own deep link — lets the session recognise
 * the come-back and close itself, which `openBrowserAsync` never does on its
 * own: it waits for a manual tap on "Done".
 *
 * The answer is deliberately narrow: `true` means THE PERSON CAME BACK THROUGH
 * THE RETURN LINK, never "the payment succeeded". Only the server knows that,
 * and a client that decides it on its own eventually grants something free.
 */

/**
 * @param {object} options
 * @param {{openURL: Function}} options.linking  react-native's Linking.
 * @param {Function} [options.loadBrowser]  Returns the in-app browser module,
 *   or null when it is absent. Must not throw — but a thrower is tolerated.
 * @param {object} [options.browserOptions]  Passed to openBrowserAsync.
 * @returns {(url: string, returnUrl?: string) => Promise<boolean>}
 */
function createCheckoutOpener(options = {}) {
  const linking = options.linking;
  if (!linking || typeof linking.openURL !== 'function') {
    throw new Error('createCheckoutOpener requires options.linking with openURL.');
  }
  const loadBrowser = typeof options.loadBrowser === 'function' ? options.loadBrowser : () => null;
  const browserOptions = options.browserOptions || { dismissButtonStyle: 'done', showTitle: true };

  function browser() {
    try {
      return loadBrowser() || null;
    } catch {
      return null;
    }
  }

  async function elsewhere(url) {
    try {
      await linking.openURL(url);
    } catch {
      /* no browser at all on the device: nothing left to try */
    }
    return false;
  }

  return async function openCheckout(url, returnUrl) {
    if (typeof url !== 'string' || !url) return false;

    const web = browser();
    if (!web) return elsewhere(url);

    try {
      if (returnUrl && typeof web.openAuthSessionAsync === 'function') {
        const result = await web.openAuthSessionAsync(url, returnUrl);
        return Boolean(result && result.type === 'success');
      }
      await web.openBrowserAsync(url, browserOptions);
      return false;
    } catch {
      return elsewhere(url);
    }
  };
}

module.exports = { createCheckoutOpener };
