/**
 * When to look for an over-the-air update, and when to apply it.
 *
 * Fixing a typo should not cost a store review: that is what remote updates
 * are for. But they are worth nothing if the app never asks for them — the
 * first app this came from never did — and they do harm when applied at the
 * wrong moment: reloading the screen while someone is filling in a payment
 * form loses the form.
 *
 * expo-updates is INJECTED, like the keystore: it is a native module, and the
 * rules below must run in plain Node.
 */

/** One hour between checks: more often pays network for nothing. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The grace period before applying in the background. Answering a text and
 * coming back takes a few seconds: reloading during that round trip sent the
 * person back to the splash screen, their page gone. Past the grace period the
 * absence is a real one — nobody sees the reload.
 */
const UPDATE_APPLY_GRACE_MS = 45 * 1000;

/**
 * Should the update server be asked?
 * @param {{enabled: boolean, online: boolean, lastCheckAt: number|null, now: number}} context
 *   `enabled` is false for a build without updates (a development client, a
 *   build with updates switched off).
 * @param {number} [intervalMs]
 */
function shouldCheckForUpdate(context, intervalMs = UPDATE_CHECK_INTERVAL_MS) {
  if (!context || !context.enabled || !context.online) return false;
  if (context.lastCheckAt === null || context.lastCheckAt === undefined) return true;
  return context.now - context.lastCheckAt >= intervalMs;
}

/**
 * Reload now? Asked when the grace period lapses, never at the instant the app
 * goes to the background.
 *
 * Never in front of the person — if they are already back, nothing happens —
 * and never with writes still queued: a reload in the middle of flushing the
 * queue could replay an entry before it is marked as sent.
 *
 * @param {{downloaded: boolean, stillInBackground: boolean, pendingWrites: number}} context
 */
function shouldApplyUpdate(context) {
  return Boolean(context && context.downloaded && context.stillInBackground && context.pendingWrites === 0);
}

/**
 * The release name for crash reporting: the binary AND the update it runs. A
 * crash report that names only the store version cannot tell two updates of
 * the same binary apart.
 */
function describeRelease({ version, updateId, isEmbeddedLaunch } = {}) {
  const base = version || '0.0.0';
  if (isEmbeddedLaunch || !updateId) return `${base}+embedded`;
  return `${base}+${String(updateId).slice(0, 8)}`;
}

/**
 * Wires the rules to expo-updates and the app state.
 *
 * @param {object} options
 * @param {object} options.updates  expo-updates' module namespace: isEnabled,
 *   isEmbeddedLaunch, updateId, channel, runtimeVersion, checkForUpdateAsync,
 *   fetchUpdateAsync, reloadAsync.
 * @param {{currentState: string, addEventListener: Function}} options.appState
 *   React Native's AppState.
 * @param {() => boolean} [options.isOnline]  Default: always. Pass the
 *   connectivity monitor's shouldAttemptRequest.
 * @param {() => number} [options.pendingWrites]  Writes still waiting for the
 *   network. Default: none.
 * @param {(error: unknown, context: {where: string}) => void} [options.onError]
 * @param {number} [options.checkIntervalMs]
 * @param {number} [options.graceMs]
 * @param {() => number} [options.now]
 */
function createUpdateWatcher(options = {}) {
  const updates = options.updates;
  const appState = options.appState;
  if (!updates) throw new Error('createUpdateWatcher: an updates module is required.');
  if (!appState) throw new Error('createUpdateWatcher: an appState is required.');

  const isOnline = typeof options.isOnline === 'function' ? options.isOnline : () => true;
  const pendingWrites = typeof options.pendingWrites === 'function' ? options.pendingWrites : () => 0;
  const onError = typeof options.onError === 'function' ? options.onError : () => undefined;
  const checkIntervalMs = Number.isFinite(options.checkIntervalMs) ? options.checkIntervalMs : UPDATE_CHECK_INTERVAL_MS;
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : UPDATE_APPLY_GRACE_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let lastCheckAt = null;
  let downloaded = false;
  let applyTimer = null;
  let subscription = null;

  async function check(at = now()) {
    const due = shouldCheckForUpdate(
      { enabled: Boolean(updates.isEnabled), online: Boolean(isOnline()), lastCheckAt, now: at },
      checkIntervalMs
    );
    if (!due) return false;
    lastCheckAt = at;
    try {
      const result = await updates.checkForUpdateAsync();
      if (!result || !result.isAvailable) return false;
      const fetched = await updates.fetchUpdateAsync();
      const isNew = Boolean(fetched && fetched.isNew);
      downloaded = downloaded || isNew;
      return isNew;
    } catch (error) {
      /* An unreachable update server is not an app crash; it is reported to be
         seen if it happens often, nothing more. */
      onError(error, { where: 'checkForUpdate' });
      return false;
    }
  }

  /* When the grace period lapses. On iOS a timer frozen in the background
     fires on return to the foreground: the stillInBackground guard turns that
     late shot into a non-event, never into a reload under the person's eyes. */
  async function applyAfterGrace() {
    applyTimer = null;
    const stillInBackground = appState.currentState !== 'active';
    if (!shouldApplyUpdate({ downloaded, stillInBackground, pendingWrites: Number(pendingWrites()) || 0 })) return;
    downloaded = false;
    try {
      await updates.reloadAsync();
    } catch (error) {
      onError(error, { where: 'reloadAsync' });
    }
  }

  function cancelApply() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = null;
  }

  function onAppStateChange(state) {
    if (state === 'active') {
      /* The person is back: the deferred reload no longer has a reason to be. */
      cancelApply();
      void check();
      return;
    }
    if (state === 'background' && downloaded && !applyTimer) {
      applyTimer = setTimeout(() => void applyAfterGrace(), graceMs);
    }
  }

  return {
    /** Call once, when the root mounts. Idempotent. */
    start() {
      if (subscription) return;
      subscription = appState.addEventListener('change', onAppStateChange) || { remove() {} };
      void check();
    },

    stop() {
      cancelApply();
      if (subscription && typeof subscription.remove === 'function') subscription.remove();
      subscription = null;
    },

    check,

    /** Whether an update is downloaded and waiting for the next quiet moment. */
    hasPendingUpdate: () => downloaded,

    /** What this phone actually runs — for crash reports and a help screen. */
    describeBuild(version) {
      return {
        updateId: updates.updateId ?? null,
        channel: updates.channel ?? null,
        runtimeVersion: updates.runtimeVersion ?? null,
        isEmbeddedLaunch: Boolean(updates.isEmbeddedLaunch),
        release: describeRelease({
          version: version ?? null,
          updateId: updates.updateId,
          isEmbeddedLaunch: updates.isEmbeddedLaunch
        })
      };
    }
  };
}

module.exports = {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_APPLY_GRACE_MS,
  shouldCheckForUpdate,
  shouldApplyUpdate,
  describeRelease,
  createUpdateWatcher
};
