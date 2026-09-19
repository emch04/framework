/**
 * What "online" means, exactly — and who gets to say it.
 *
 * An app with no network signal ends up inferring one from the last request:
 * a status pill that says "offline" when the SERVER fell over, blaming the
 * person's network, and stays green while a request hangs.
 *
 * The OS knows three distinct things, and conflating them is the classic trap:
 *
 *   - `isConnected`: an interface is up. A hotel wifi that wants a login page
 *     says YES, and nothing gets through.
 *   - `isInternetReachable`: the OS's own verdict on the outside world. It is
 *     `null` for the first seconds after launch, and — see below — its "no"
 *     is about Google, not about us.
 *   - the link type (wifi, cellular, none).
 *
 * The rule: offline only when the OS has NO interface at all. Everything else
 * is either proven online or unknown, and unknown lets requests go out. OUR
 * requests are what settle it: a transport failure is remembered for a short
 * while (the blackout below), and a success clears it.
 *
 * NetInfo is INJECTED, like the keystore: importing it here would drag a native
 * module into every test and into every place it is absent.
 */

/** Thirty seconds: long enough to spare the next screens the wait, short
 * enough that a passing outage does not condemn the app. */
const TRANSPORT_BLACKOUT_MS = 30_000;

/**
 * @param {{isConnected?: boolean|null, isInternetReachable?: boolean|null}|null|undefined} snapshot
 * @returns {'online'|'offline'|'unknown'}  `unknown` is a state of its own, not
 *   a default: it lets the UI stay silent instead of announcing an outage it
 *   has not observed.
 */
function readReachability(snapshot) {
  if (!snapshot) return 'unknown';

  /* No interface at all: the only case where the OS is certain without having
     to reach anything. */
  if (snapshot.isConnected === false) return 'offline';

  /* An interface the OS calls "no Internet" is NOT proof of an outage. Seen in
     production: that verdict does not come from our server. On Android it is
     the wifi's "validated" flag, set only after reaching a Google endpoint;
     elsewhere NetInfo probes a Google URL itself. On a wifi where that test
     fails (provider DNS, filtering, slowness) the network is declared dead
     while the app's own requests go through: the app showed "offline" on
     wifi alone, and believed itself online only with mobile data switched on
     too (the OS then validated through 4G).

     So it stays unknown, requests go out, and a real failure is caught by the
     transport blackout. Captive portals and exhausted data plans are still
     detected — by the failure itself, not by Google's probe. */
  if (snapshot.isInternetReachable === false) return 'unknown';

  if (snapshot.isConnected === true && snapshot.isInternetReachable === true) return 'online';

  /* Interface up, verdict not rendered yet. Treating that as an outage would
     flash "offline" on every launch and teach people to ignore the pill. */
  return 'unknown';
}

/**
 * The current link, from the point of view of what it COSTS.
 *
 * Not the same question as "are we online": a download on home wifi is free,
 * the same one on mobile data is paid by the megabyte. Ethernet and a docked
 * tablet's wifi sit on the same side; whatever cannot be named is `unknown`,
 * and callers should treat unknown as metered.
 *
 * @returns {'wifi'|'cellular'|'none'|'unknown'}
 */
function readConnectionLink(snapshot) {
  if (!snapshot) return 'unknown';
  if (readReachability(snapshot) === 'offline') return 'none';
  const type = String(snapshot.type ?? '').toLowerCase();
  if (type === 'wifi' || type === 'ethernet' || type === 'wimax') return 'wifi';
  if (type === 'cellular') return 'cellular';
  if (type === 'none') return 'none';
  return 'unknown';
}

/** Should an outage be announced? Only an established one. */
function isDefinitelyOffline(snapshot) {
  return readReachability(snapshot) === 'offline';
}

/**
 * Is a request worth attempting? Yes, unless certain otherwise. Blocking on
 * `unknown` would stop the app from starting during the seconds the OS has not
 * decided yet — that is, on every launch.
 */
function worthAttempting(snapshot) {
  return readReachability(snapshot) !== 'offline';
}

/**
 * Did the network just come back? That transition, and only it, should trigger
 * a reload. Reacting to "we are online" would refire every request on each OS
 * notification, including when nothing changed.
 */
function hasComeBack(previous, next) {
  return previous === 'offline' && next === 'online';
}

/**
 * Does a failed request prove the NETWORK is down?
 *
 * The blackout stops EVERY request: it must only be raised when the network is
 * to blame. A server taking longer than the timeout — peak hour, a heavy
 * endpoint — expires exactly like a captive wifi. The OS knows the difference:
 * when it AFFIRMS the Internet is reachable, a timeout blames the server, and
 * flipping the app offline on a healthy connection would serve stale cache to
 * every screen.
 *
 * A transport refusal ("Network request failed") is conclusive whatever the OS
 * says: the request never left.
 *
 * @param {{reason: 'timeout'|'unreachable', reachability: 'online'|'offline'|'unknown'}} input
 */
function shouldDeclareTransportDown({ reason, reachability } = {}) {
  if (reason === 'unreachable') return true;
  return reachability !== 'online';
}

/** NetInfo's state, narrowed to what the rules read. */
function toSnapshot(state) {
  const source = state || {};
  return {
    isConnected: source.isConnected ?? null,
    isInternetReachable: source.isInternetReachable ?? null,
    type: source.type ?? null
  };
}

/**
 * One subscription to the OS for the whole app.
 *
 * Every screen with its own NetInfo listener keeps the radio busy for nothing,
 * and on an entry-level phone that is paid in battery. Screens subscribe to
 * this monitor, not to the OS.
 *
 * @param {object} [options]
 * @param {{addEventListener: Function, fetch: Function}} [options.netInfo]
 *   @react-native-community/netinfo's default export, or anything shaped like
 *   it. Only needed for start() and refresh().
 * @param {number} [options.blackoutMs]  How long a transport failure is
 *   remembered.
 * @param {() => number} [options.now]
 */
function createConnectivityMonitor(options = {}) {
  const netInfo = options.netInfo || null;
  const blackoutMs = Number.isFinite(options.blackoutMs) ? options.blackoutMs : TRANSPORT_BLACKOUT_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let snapshot = null;
  let reachability = 'unknown';
  let unsubscribeNetInfo = null;

  const listeners = new Set();
  const comebackListeners = new Set();

  let transportDownUntil = 0;
  let blackoutTimer = null;
  let recoveryProbe = null;

  function notifyAll() {
    for (const notify of [...listeners]) notify();
  }

  function notifyComeback() {
    for (const notify of [...comebackListeners]) notify();
  }

  function clearTransportDown() {
    transportDownUntil = 0;
    if (blackoutTimer) clearTimeout(blackoutTimer);
    blackoutTimer = null;
  }

  function publish(next, emitComeback = true) {
    const previous = reachability;
    /* The link TYPE counts separately: moving from wifi to mobile data leaves
       "online" unchanged, and changes everything for what is paid by the
       megabyte. Without this second witness, a settings screen kept announcing
       wifi after the person left the house. */
    const previousLink = readConnectionLink(snapshot);
    snapshot = next;
    reachability = readReachability(next);
    if (previous === reachability && previousLink === readConnectionLink(next)) return;

    notifyAll();
    /* The return of the network is an EVENT, not a state: it restarts what had
       failed, once. What we had observed no longer holds. */
    if (hasComeBack(previous, reachability)) {
      clearTransportDown();
      if (emitComeback) notifyComeback();
    }
  }

  /**
   * The end of the blackout, and the question put back to the server.
   *
   * The blackout used to be read off the clock, and nobody was told when it
   * lapsed: a status bell sat on "offline" until something else repainted it,
   * and screens that had fallen back to cache stayed there, since the only
   * recovery signal was the RADIO coming back — and it had never left. Seen
   * against a dev server restarted by a file watcher several times a minute:
   * each restart refused one connection, and the app believed itself offline
   * long after the server answered again.
   *
   * So at expiry the screens are told, and ONE light request goes to the
   * server. If it succeeds, noteTransportSuccess() announces the recovery; if
   * it fails, the blackout restarts. Nothing is sent while the OS affirms
   * there is no network: its own return will take care of it.
   */
  function armBlackoutTimer() {
    if (blackoutTimer) clearTimeout(blackoutTimer);
    blackoutTimer = setTimeout(() => {
      blackoutTimer = null;
      notifyAll();
      if (reachability !== 'offline' && recoveryProbe) {
        Promise.resolve()
          .then(() => recoveryProbe())
          .catch(() => undefined);
      }
    }, blackoutMs);
  }

  function isTransportDown() {
    return now() < transportDownUntil;
  }

  /**
   * A request failed in transport. Remember it: the case that hurts most is
   * never obvious to the OS — the wifi that accepts the connection and lets
   * nothing through. `isInternetReachable` stays null there, and every screen
   * paid the full request timeout before showing its cache. With the
   * blackout, the first screen pays the wait, the next ones show cache at once.
   *
   * @param {'timeout'|'unreachable'} [reason]
   */
  function noteTransportFailure(reason = 'unreachable') {
    /* A timeout on a network the OS calls healthy blames the server, not the
       connection: it does not cut everyone's requests for thirty seconds. */
    if (!shouldDeclareTransportDown({ reason, reachability })) return;
    /* Compared to the clock, not to zero: an expired blackout leaves its date
       behind, and a `!transportDownUntil` test silenced the next outage. */
    const wasDown = isTransportDown();
    transportDownUntil = now() + blackoutMs;
    armBlackoutTimer();
    /* The blackout is news: a screen open for an hour must learn it without
       having asked anything itself. */
    if (!wasDown) notifyAll();
  }

  /** Any request that got an answer. Clears the blackout and, if there was one,
   * announces the recovery like the radio's own return would. */
  function noteTransportSuccess() {
    if (!transportDownUntil) return;
    clearTransportDown();
    notifyAll();
    if (reachability !== 'offline') notifyComeback();
  }

  function onNetInfoState(state) {
    publish(toSnapshot(state));
  }

  return {
    /** Start listening to the OS. Idempotent: a second call does nothing. */
    start() {
      if (unsubscribeNetInfo) return;
      if (!netInfo) throw new Error('createConnectivityMonitor: start() needs a netInfo adapter.');
      const subscription = netInfo.addEventListener(onNetInfoState);
      unsubscribeNetInfo = typeof subscription === 'function'
        ? subscription
        : () => subscription && typeof subscription.remove === 'function' && subscription.remove();
      Promise.resolve()
        .then(() => netInfo.fetch())
        .then(onNetInfoState)
        .catch(() => undefined);
    },

    stop() {
      if (unsubscribeNetInfo) unsubscribeNetInfo();
      unsubscribeNetInfo = null;
      clearTransportDown();
    },

    /**
     * Re-read the OS, for a background task waking from suspension: the last
     * known state may be frozen. The comeback event is NOT emitted — it would
     * start a second flush alongside the one the background task is about to
     * run itself.
     * @returns {Promise<boolean>}  Whether a request is worth attempting.
     */
    async refresh() {
      if (!netInfo) throw new Error('createConnectivityMonitor: refresh() needs a netInfo adapter.');
      publish(toSnapshot(await netInfo.fetch()), false);
      return worthAttempting(snapshot);
    },

    /** Feed a state by hand — tests, or a platform with its own source. */
    setSnapshot(next) {
      publish(toSnapshot(next));
    },

    getReachability: () => reachability,
    getConnectionLink: () => readConnectionLink(snapshot),
    isTransportDown,

    /** One answer for the whole app: the OS affirms no network, or the app has
     * just observed that nothing gets through. */
    isOffline: () => reachability === 'offline' || isTransportDown(),

    /** A blackout just observed is a certainty, even before the OS decides. */
    shouldAttemptRequest: () => !isTransportDown() && worthAttempting(snapshot),

    noteTransportFailure,
    noteTransportSuccess,

    /** The light request fired when a blackout lapses. Null disables it. */
    setRecoveryProbe(probe) {
      recoveryProbe = typeof probe === 'function' ? probe : null;
    },

    /** Any change of state or link. Shaped for useSyncExternalStore. */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * The network came BACK. Separate from subscribe(): a screen that reloads
     * on recovery has no reason to re-render on every OS heartbeat.
     */
    onComeback(listener) {
      comebackListeners.add(listener);
      return () => {
        comebackListeners.delete(listener);
      };
    }
  };
}

module.exports = {
  TRANSPORT_BLACKOUT_MS,
  readReachability,
  readConnectionLink,
  isDefinitelyOffline,
  worthAttempting,
  hasComeBack,
  shouldDeclareTransportDown,
  createConnectivityMonitor
};
