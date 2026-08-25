/**
 * The rule that keeps a real key where it belongs.
 *
 * A development machine and production often share one credential store — that
 * is the whole point of storing keys centrally. It is harmless while the values
 * are test values; it is a disaster the day a laptop picks up a live payment
 * key and starts charging real cards.
 *
 * So the judgement is made on the VALUE, not on the environment alone:
 *
 *   a test value  → usable anywhere;
 *   a live value  → production only, no exception.
 *
 * Some keys cannot classify themselves. A webhook signing secret says nothing
 * about which account it belongs to — but it belongs to the SAME account as the
 * secret key, and must follow its fate. That is what `decidingKey` expresses:
 * without it you would block the live key and let the matching signature
 * through.
 *
 * Astratra guards nothing by default. Which keys move money, and how a live
 * value is recognised, is the product's business.
 */

const LIVE = 'live';
const TEST = 'test';
const UNKNOWN = 'unknown';

const DEFAULT_RESTRICTED_MESSAGE =
  'A live value for this key can only be saved from production. From anywhere else it would act on real data.';

function buildClassifier(options) {
  if (typeof options.classify === 'function') return options.classify;

  const livePattern = options.livePattern || null;
  const testPattern = options.testPattern || null;
  if (!livePattern && !testPattern) {
    /* Nothing to recognise: every value is unclassified, and unclassified is
       never treated as live. A guard that cannot tell must not block. */
    return () => UNKNOWN;
  }

  return (value) => {
    const text = String(value == null ? '' : value);
    if (livePattern && livePattern.test(text)) return LIVE;
    if (testPattern && testPattern.test(text)) return TEST;
    return UNKNOWN;
  };
}

/**
 * @param {object}   [options]
 * @param {string[]} [options.keys]         key names this guard applies to.
 * @param {string}   [options.decidingKey]  the key whose value classifies the group.
 * @param {Function} [options.classify]     (value) => 'live'|'test'|'unknown'.
 * @param {RegExp}   [options.livePattern]  used when `classify` is not given.
 * @param {RegExp}   [options.testPattern]  used when `classify` is not given.
 * @param {Function} [options.isProduction] () => boolean.
 * @param {string}   [options.restrictedMessage] shown when a write is refused.
 */
function createValueGuard(options = {}) {
  const guarded = new Set(options.keys || []);
  const decidingKey = options.decidingKey || null;
  const classify = buildClassifier(options);
  const isProduction = options.isProduction
    || (() => (options.env || process.env).NODE_ENV === 'production');
  const restrictedMessage = options.restrictedMessage || DEFAULT_RESTRICTED_MESSAGE;

  const isGuarded = (name) => guarded.has(name);

  /**
   * May this key be read from the store, here and now?
   * @param {string} name
   * @param {object} [context]
   * @param {*} [context.value]        the value stored for this key.
   * @param {*} [context.decidingValue] the value stored for the deciding key.
   */
  function mayRead(name, context = {}) {
    if (!isGuarded(name) || isProduction()) return true;
    /* Its own value first — a live secret key recognises itself. */
    if (classify(context.value) === LIVE) return false;
    /* Then the group's, for the keys that cannot speak for themselves. */
    return classify(context.decidingValue) !== LIVE;
  }

  /**
   * May this value be written from here?
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  function mayWrite(name, value) {
    if (!isGuarded(name) || isProduction()) return { ok: true };
    if (classify(value) === LIVE) return { ok: false, reason: restrictedMessage };
    return { ok: true };
  }

  /**
   * Would a live value be refused here, whatever it is?
   *
   * The settings screen asks this before showing an input: letting someone
   * type a key only to have it refused on save is a worse experience than
   * saying up front that this machine cannot hold one.
   */
  function restrictsHere(name) {
    if (!isGuarded(name) || isProduction()) return { ok: true };
    return { ok: false, reason: restrictedMessage };
  }

  return { isGuarded, classify, mayRead, mayWrite, restrictsHere, decidingKey, isProduction };
}

/** A guard that allows everything — the default when a product declares none. */
function createPermissiveGuard() {
  return createValueGuard();
}

module.exports = { createValueGuard, createPermissiveGuard, LIVE, TEST, UNKNOWN };
