/**
 * Consent on the device: its memory, its sync with the account, and THE guard.
 *
 * Every send towards the AI — a typed question, a voice note, a text read
 * aloud, a generated quiz — calls `require()` just before leaving. Without a
 * valid consent nothing leaves: the guard throws instead of reaching the
 * network.
 *
 * The decision lives on the ACCOUNT, with a copy on the device. The copy serves
 * offline and against a server too old to know the route; the merge rules are
 * mergeDecisions(). What this adds is what the pure rules cannot hold:
 *
 *   - the local copy is shown at once — a slow server must not leave the
 *     screen on a spinner — while the guard waits for the merge;
 *   - a load that started BEFORE a decision was taken never overwrites it on
 *     its way back from the server;
 *   - two loads for the same account share one request;
 *   - one account never benefits from the consent of another account on the
 *     same device.
 *
 * Storage and network are injected, so the same code runs on a phone, in a
 * browser or in a test.
 */
const { CONSENT_CODES, ConsentError, consentState, mergeDecisions, newDecision, readDecision } = require('./consent');

/**
 * @param {object} options
 * @param {number} options.version  the version of the text this client shows.
 * @param {object} options.local    { get(key) -> string|null, set(key, string) } — AsyncStorage, localStorage…
 * @param {object} options.remote   { get() -> decision|null, put({ granted, version }) -> decision }. May throw.
 * @param {Function} [options.currentSubject] () => subject id, for require()/isGranted().
 * @param {string} [options.keyPrefix]  local storage key prefix. Default 'consent'.
 * @param {string} [options.scope]      part of the local key. Default 'ai'.
 * @param {Function} [options.now]
 * @param {Function} [options.onError]  (where, error) => void — a failed write or push is reported, not thrown.
 */
function createConsentClient(options = {}) {
  const version = options.version;
  if (!Number.isInteger(version) || version < 1) throw new Error('createConsentClient requires an integer options.version.');
  const local = options.local;
  if (!local || typeof local.get !== 'function' || typeof local.set !== 'function') {
    throw new Error('createConsentClient requires options.local with get() and set().');
  }
  const remote = options.remote;
  if (!remote || typeof remote.get !== 'function' || typeof remote.put !== 'function') {
    throw new Error('createConsentClient requires options.remote with get() and put().');
  }
  const currentSubject = options.currentSubject || (() => null);
  const prefix = options.keyPrefix || 'consent';
  const scope = options.scope || 'ai';
  const now = options.now || (() => new Date());
  const onError = options.onError || (() => {});

  const keyOf = (subject) => `${prefix}.${scope}.${subject}`;

  let state = { subject: null, decision: null, loaded: false };
  const listeners = new Set();
  let loading = null;
  /* Raised by every decision taken on screen: a load that left before it must
     not overwrite it when it comes back. */
  let generation = 0;

  function publish(next) {
    state = next;
    for (const listener of listeners) {
      try { listener(state); } catch (_error) { /* a listener never breaks the store */ }
    }
  }

  async function readLocal(subject) {
    try {
      const raw = await local.get(keyOf(subject));
      return raw ? readDecision(JSON.parse(raw)) : null;
    } catch (_error) {
      return null;
    }
  }

  async function writeLocal(subject, decision) {
    try {
      await local.set(keyOf(subject), JSON.stringify(decision));
    } catch (error) {
      onError('local', error);
    }
  }

  async function readRemote() {
    try {
      return readDecision(await remote.get());
    } catch (_error) {
      /* Offline, server down, or a server older than the route (404): the
         device's copy decides alone. */
      return 'unavailable';
    }
  }

  async function push(decision) {
    try {
      await remote.put({ granted: decision.granted, version: decision.version });
    } catch (error) {
      /* Nothing is lost: the local copy is newer and is pushed again on the
         next load. */
      onError('push', error);
    }
  }

  /** The account's decision, local and remote merged. Without refresh, a loaded account costs no request. */
  function load(subject, { refresh = false } = {}) {
    if (subject === null || subject === undefined) return Promise.resolve(null);
    const id = String(subject);
    if (!refresh && state.subject === id && state.loaded) return Promise.resolve(state.decision);
    if (loading && loading.subject === id) return loading.promise;
    const started = generation;
    const promise = (async () => {
      const localCopy = await readLocal(id);
      if (started === generation && (state.subject !== id || !state.loaded)) {
        publish({ subject: id, decision: localCopy, loaded: true });
      }
      const remoteCopy = await readRemote();
      const { kept, push: mustPush } = mergeDecisions(localCopy, remoteCopy);
      if (started !== generation) return state.subject === id ? state.decision : kept;
      if (kept && kept !== localCopy) await writeLocal(id, kept);
      if (mustPush && kept) void push(kept);
      publish({ subject: id, decision: kept, loaded: true });
      return kept;
    })().finally(() => {
      if (loading && loading.promise === promise) loading = null;
    });
    loading = { subject: id, promise };
    return promise;
  }

  /** Accept (true), refuse or withdraw (false). */
  async function decide(subject, granted) {
    const id = String(subject);
    const decision = newDecision(Boolean(granted), version, now());
    generation += 1;
    publish({ subject: id, decision, loaded: true });
    await writeLocal(id, decision);
    await push(decision);
    return decision;
  }

  /** THE guard: call it just before any send. Throws CONSENT_REQUIRED / CONSENT_REFUSED. */
  async function require(subject) {
    const id = subject === undefined ? currentSubject() : subject;
    const fallback = id === null || id === undefined ? state.subject : id;
    const decision = fallback === null || fallback === undefined ? null : await load(fallback);
    const current = consentState(decision, version);
    if (current !== 'granted') {
      throw new ConsentError(current === 'refused' ? CONSENT_CODES.REFUSED : CONSENT_CODES.REQUIRED, { scope });
    }
  }

  /** For callers that would rather stay silent than throw. */
  async function isGranted(subject) {
    try {
      await require(subject);
      return true;
    } catch (_error) {
      return false;
    }
  }

  return {
    load,
    decide,
    require,
    isGranted,
    state: () => state,
    stateOf: () => consentState(state.decision, version),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version
  };
}

module.exports = { createConsentClient };
