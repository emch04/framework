/**
 * Asking the server which version the store expects, and remembering it.
 *
 * No React Native here: the request, the disk, the installed version, the
 * clock and the foreground signal are all injected. The shape of
 * `subscribe`/`getSnapshot` is `useSyncExternalStore`'s, so a UI layer binds
 * to it in one line — and the snapshot object only changes when something
 * changed, which that hook requires.
 *
 * This only WARNS that a new binary waits in the store. Only the person can
 * install it; nothing here pretends otherwise.
 */
const {
  STORE_CHECK_INTERVAL_MS,
  versionStatus,
  isBannerVisible,
  shouldCheckStore,
  infoForPlatform,
  readStoreCopy
} = require('./versionStatus');

/**
 * @param {object} options
 * @param {() => Promise<unknown>} options.fetchVersions  Returns the manifest (unwrap your API envelope here).
 * @param {{getItem(key: string): Promise<string|null>|string|null, setItem(key: string, value: string): Promise<void>|void}} options.storage
 * @param {() => string | null | undefined} options.installedVersion  The BINARY's version, not an OTA bundle's.
 * @param {string} options.platform  'ios' | 'android'.
 * @param {() => boolean} [options.isOnline]
 * @param {() => number} [options.now]
 * @param {(listener: () => void) => (() => void) | {remove(): void} | void} [options.onForeground]
 * @param {string} [options.namespace]
 * @param {number} [options.intervalMs]
 */
function createStoreVersionWatcher(options = /** @type {any} */ ({})) {
  const {
    fetchVersions,
    storage,
    installedVersion,
    platform,
    isOnline = () => true,
    now = () => Date.now(),
    onForeground = null,
    namespace = 'app',
    intervalMs = STORE_CHECK_INTERVAL_MS
  } = options;

  if (typeof fetchVersions !== 'function') throw new TypeError('createStoreVersionWatcher: fetchVersions is required');
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('createStoreVersionWatcher: storage needs getItem() and setItem()');
  }
  if (typeof installedVersion !== 'function') throw new TypeError('createStoreVersionWatcher: installedVersion is required');

  /* Per device, not per account: it is the phone that is behind. */
  const COPY_KEY = `${namespace}.storeVersion.copy`;
  const DISMISSED_KEY = `${namespace}.storeVersion.dismissed`;

  let state = { data: null, dismissed: null };
  let snapshot = compute();
  let lastCheck = null;
  let inFlight = null;
  let started = false;
  let stopForeground = null;
  const listeners = new Set();

  function compute() {
    const installed = installedVersion() ?? null;
    const info = infoForPlatform(state.data, platform);
    const status = versionStatus(installed, info);
    return { status, installed, info, banner: isBannerVisible(status, info && info.latest, state.dismissed) };
  }

  function publish(next) {
    state = { ...state, ...next };
    snapshot = compute();
    for (const listener of [...listeners]) listener();
  }

  /** Reads the last answer and the dismissed version back, for an offline launch. */
  async function readDisk() {
    try {
      const [copy, dismissed] = await Promise.all([storage.getItem(COPY_KEY), storage.getItem(DISMISSED_KEY)]);
      const saved = readStoreCopy(copy);
      /* An answer that arrived from the network while the disk was being read is fresher. */
      publish({ data: state.data ?? (saved ? saved.data : null), dismissed: dismissed ?? state.dismissed });
      /* Six hours counted from the last answer, across launches too. */
      if (saved && lastCheck === null) lastCheck = saved.receivedAt;
    } catch (_error) {
      // An unreadable disk is a first launch: the network will be asked.
    }
  }

  /**
   * Asks the server, if the rule allows it. `force` serves the screen opened
   * from the announcement push: it was just announced, it must be right.
   * Never throws — offline or unreachable, the last known answer stays.
   */
  function check({ force = false } = {}) {
    if (inFlight) return inFlight;
    const at = now();
    if (!shouldCheckStore({ lastCheck, now: at, online: Boolean(isOnline()), force, intervalMs })) {
      return Promise.resolve();
    }
    inFlight = (async () => {
      try {
        const data = await fetchVersions();
        lastCheck = at;
        publish({ data });
        try {
          await storage.setItem(COPY_KEY, JSON.stringify({ data, receivedAt: at }));
        } catch (_error) {
          // Without a copy the next offline launch says nothing: no harm done.
        }
      } catch (_error) {
        /* Silently: keep what was known and try again on the next return
           to the foreground. */
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** "Later": the banner goes quiet for THIS version only. */
  async function dismiss(version) {
    publish({ dismissed: version });
    try {
      await storage.setItem(DISMISSED_KEY, String(version));
    } catch (_error) {
      // Not persisted: the banner comes back at next launch, nothing worse.
    }
  }

  /** Call once, at the root. Reads the disk, then asks the network. */
  function start() {
    if (started) return Promise.resolve();
    started = true;
    if (typeof onForeground === 'function') {
      const subscription = onForeground(() => { void check(); });
      stopForeground = typeof subscription === 'function'
        ? subscription
        : subscription && typeof subscription.remove === 'function' ? () => subscription.remove() : null;
    }
    return readDisk().then(() => check());
  }

  function stop() {
    if (stopForeground) stopForeground();
    stopForeground = null;
    started = false;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { start, stop, check, dismiss, subscribe, getSnapshot: () => snapshot };
}

module.exports = { createStoreVersionWatcher };
