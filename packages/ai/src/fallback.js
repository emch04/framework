/**
 * Answering when every provider is down.
 *
 * The norm, when the last AI provider in the chain fails, is an error message.
 * The alternative is a DETERMINISTIC answer: computed without any model, from
 * the data you already have. It is not as good — and it is never a blank
 * screen. A parent asking about their child's average gets the average and a
 * plain sentence, not "service unavailable, try later".
 *
 * The honesty rule is the part that matters: a fallback answer SAYS it is one.
 * Serving a degraded answer as if nothing happened teaches users to distrust
 * the good ones.
 */

/**
 * @param {object} options
 * @param {Record<string, Function>} options.responders  intent -> async (input) => answer.
 *   Each one is plain code: a template over data, no model anywhere.
 * @param {Function} [options.classify] (input) => intent. Defaults to reading
 *   `input.intent`. Keyword matching is the usual implementation — crude, and
 *   crude is fine here: this path only runs when everything better is down.
 * @param {Function} [options.markDegraded] (answer) => answer, applied to every
 *   fallback response so the caller — and the user — can tell.
 */
function createDeterministicFallback(options = {}) {
  const responders = options.responders || {};
  if (!Object.keys(responders).length) {
    throw new Error('createDeterministicFallback requires at least one responder.');
  }

  const classify = options.classify || ((input) => input && input.intent);
  const markDegraded = options.markDegraded
    || ((answer) => ({ ...answer, degraded: true }));

  /**
   * @returns {Promise<{handled: boolean, answer?: object}>}
   *   handled: false means "no deterministic answer exists for this" — the
   *   caller then apologises honestly instead of inventing.
   */
  async function answer(input) {
    const intent = classify(input);
    const responder = intent && responders[intent];
    if (!responder) return { handled: false };

    const produced = await responder(input);
    if (produced === null || produced === undefined) return { handled: false };

    const shaped = typeof produced === 'object' ? produced : { text: String(produced) };
    return { handled: true, answer: markDegraded(shaped) };
  }

  /**
   * Wrap a provider call: try it, fall back when it throws.
   *
   * The provider error is carried alongside the fallback answer — silently
   * eating it would hide the outage from your own monitoring.
   */
  async function withFallback(ask, input) {
    try {
      return { degraded: false, answer: await ask(input) };
    } catch (error) {
      const fallen = await answer(input);
      if (fallen.handled) return { degraded: true, answer: fallen.answer, providerError: error };
      throw error;
    }
  }

  return { answer, withFallback, intents: Object.keys(responders) };
}

module.exports = { createDeterministicFallback };
