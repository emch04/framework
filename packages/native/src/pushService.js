/**
 * Registering a phone for push, and the six ways it goes wrong.
 *
 * The state machine itself is small. What earns its keep here is everything
 * around it — each rule below came from a defect that shipped.
 *
 * A DEVICE NEEDS A STABLE IDENTITY. The push token changes: on reinstall, on
 * restore, whenever the OS feels like it. Keyed on the token, a server ends up
 * with six rows for one phone, all but one dead. The installation id is minted
 * once and kept in the keystore; the token is just its current address.
 *
 * THE STATE IS READ FROM BOTH SIDES. The OS permission is half the answer; the
 * server's record is the other half. Granted-but-unregistered is `disabled`,
 * not `enabled` — a switch showing "on" above notifications nobody will receive
 * is worse than one showing "off".
 *
 * A REFUSAL UNREGISTERS. Leaving a registration behind after the person says no
 * keeps the server sending to a phone that will never display anything.
 *
 * A COLD-START NOTIFICATION OPENS ONCE. The platform hands back the last tapped
 * notification, and clearing that cache is not reliable. Without a persisted
 * mark, every launch replays the same notification and hijacks the home screen.
 *
 * LOGOUT WAITS FOR REGISTRATIONS IN FLIGHT, THEN BLOCKS THEM. A registration
 * that started before logout and lands after it re-registers the device to an
 * account that just left — the next notification goes to the wrong person.
 *
 * LOGOUT NEVER FAILS. Offline, or on a cleanup that errors, signing out still
 * happens. An app that cannot sign out because the network is down is a trap.
 */

const INSTALLATION_ID = 'notifications.installationId';
const LAST_HANDLED = 'notifications.lastHandledId';

function supported(deps) {
  return Boolean(deps.isDevice) && (deps.platform === 'ios' || deps.platform === 'android');
}

/**
 * The OS answer, normalized. iOS reports its own enum and it disagrees with the
 * cross-platform field: provisional and ephemeral both deliver notifications
 * while `status` reads denied.
 */
function readPermission(status, notifications) {
  const ios = status && status.ios ? status.ios.status : undefined;
  const levels = notifications.IosAuthorizationStatus || {};
  if (ios !== undefined) {
    if (ios === levels.AUTHORIZED || ios === levels.PROVISIONAL || ios === levels.EPHEMERAL) return 'granted';
    if (ios === levels.NOT_DETERMINED) return 'undetermined';
    if (ios === levels.DENIED) return 'denied';
  }
  if (status && (status.granted || status.status === 'granted')) return 'granted';
  return status && status.status === 'undetermined' ? 'undetermined' : 'denied';
}

function dataOf(response) {
  const content = response && response.notification && response.notification.request
    ? response.notification.request.content
    : null;
  return (content && content.data) || {};
}

const { decideRegistrationAction } = require('./pushPolicy');

/**
 * @param {object} options
 * @param {Function} options.load  async () => dependencies (see README).
 * @param {string} [options.namespace='app']  Prefixes the stored keys.
 */
function createPushService(options = {}) {
  const load = options.load;
  if (typeof load !== 'function') throw new Error('createPushService requires options.load.');
  const namespace = options.namespace || 'app';
  const installationKey = `${namespace}.${INSTALLATION_ID}`;
  const handledKey = `${namespace}.${LAST_HANDLED}`;

  let installationIdPromise = null;
  let handlerInstalled = false;
  let categoriesInstalled = false;
  let coldStartHandled = false;
  let registrationBlocked = false;
  let logoutInProgress = false;
  let logoutPromise = null;
  const inFlight = new Set();

  function getInstallationId() {
    if (!installationIdPromise) {
      installationIdPromise = Promise.resolve(load())
        .then(async ({ randomUUID, keystore }) => {
          const stored = await keystore.getItemAsync(installationKey);
          if (stored) return stored;
          const created = randomUUID();
          await keystore.setItemAsync(installationKey, created);
          return created;
        })
        .catch((error) => {
          installationIdPromise = null;
          throw error;
        });
    }
    return installationIdPromise;
  }

  async function unregister() {
    const deps = await load();
    if (!supported(deps)) return;
    await deps.api.unregister(await getInstallationId());
  }

  async function declareChannels(deps) {
    if (deps.platform !== 'android') return;
    for (const channel of deps.channels || []) {
      await deps.notifications.setNotificationChannelAsync(channel.id, {
        name: channel.name,
        importance: deps.notifications.AndroidImportance.HIGH,
        enableVibrate: true,
        sound: 'default',
        ...channel.config
      });
    }
  }

  async function declareCategories(deps) {
    if (categoriesInstalled) return;
    for (const category of deps.categories || []) {
      await deps.notifications.setNotificationCategoryAsync(category.id, category.actions);
    }
    categoriesInstalled = true;
  }

  /** The project id may be a value or something that has to be looked up. */
  async function projectIdOf(deps) {
    const value = typeof deps.projectId === 'function' ? await deps.projectId() : deps.projectId;
    if (typeof value !== 'string' || !value.trim()) throw new Error('PUSH_PROJECT_ID_MISSING');
    return value;
  }

  async function registerNow(deps, channelsReady) {
    if (!channelsReady) await declareChannels(deps);
    const projectId = await projectIdOf(deps);
    const { data: pushToken } = await deps.notifications.getExpoPushTokenAsync({ projectId });
    const installationId = await getInstallationId();
    const device = await deps.api.register({
      installationId,
      pushToken,
      platform: deps.platform,
      ...(deps.deviceName ? { deviceName: deps.deviceName } : {})
    });
    return device && device.registered && device.enabled ? 'enabled' : 'disabled';
  }

  /** Tracked, so logout can wait for it instead of racing it. */
  async function guardedRegister(deps, channelsReady) {
    if (registrationBlocked) return 'disabled';
    const registration = registerNow(deps, channelsReady);
    inFlight.add(registration);
    try {
      return await registration;
    } finally {
      inFlight.delete(registration);
    }
  }

  async function getState() {
    try {
      const deps = await load();
      if (!supported(deps)) return 'unsupported';
      const permission = readPermission(await deps.notifications.getPermissionsAsync(), deps.notifications);
      if (permission !== 'granted') return permission;
      const device = await deps.api.current(await getInstallationId());
      return device && device.registered && device.enabled ? 'enabled' : 'disabled';
    } catch {
      return 'error';
    }
  }

  /** The person tapped the switch: prompting is allowed here, and only here. */
  async function enable() {
    try {
      const deps = await load();
      if (!supported(deps)) return 'unsupported';

      let channelsReady = false;
      if (deps.platform === 'android') {
        await declareChannels(deps);
        channelsReady = true;
      }

      let permission = readPermission(await deps.notifications.getPermissionsAsync(), deps.notifications);
      const action = decideRegistrationAction({ explicit: true, permission });
      if (action === 'open-settings') {
        await unregister();
        return 'denied';
      }
      if (action === 'request') {
        permission = readPermission(await deps.notifications.requestPermissionsAsync(), deps.notifications);
      }
      if (permission === 'denied') {
        await unregister();
        return 'denied';
      }
      if (permission !== 'granted') return permission;
      return await guardedRegister(deps, channelsReady);
    } catch {
      return 'error';
    }
  }

  /** Startup and token rotation: refresh the registration, never prompt. */
  async function sync() {
    try {
      const deps = await load();
      if (!supported(deps)) return 'unsupported';
      if (registrationBlocked) return 'disabled';
      const permission = readPermission(await deps.notifications.getPermissionsAsync(), deps.notifications);
      if (permission === 'denied') {
        await unregister();
        return 'denied';
      }
      if (decideRegistrationAction({ explicit: false, permission }) === 'none') {
        return permission === 'undetermined' ? 'undetermined' : 'error';
      }
      return await guardedRegister(deps);
    } catch {
      return 'error';
    }
  }

  async function disable() {
    try {
      const deps = await load();
      if (!supported(deps)) return 'unsupported';
      await unregister();
      return 'disabled';
    } catch {
      return 'error';
    }
  }

  function allowRegistration() {
    if (!logoutInProgress) registrationBlocked = false;
  }

  function installForegroundHandler(deps) {
    if (handlerInstalled) return;
    deps.notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true
      })
    });
    handlerInstalled = true;
  }

  /**
   * Start listening. Returns the function that stops it — call it on unmount.
   * @param {*} recipient  Passed to the router: who is looking at the phone.
   */
  async function startListeners(recipient) {
    const deps = await load();
    if (!supported(deps)) return () => undefined;

    await declareCategories(deps);
    installForegroundHandler(deps);

    let active = true;

    function handle(response) {
      if (!active) return;
      const data = dataOf(response);
      const payload = { ...data, actionIdentifier: response && response.actionIdentifier };

      /* An action button may be answered in place — approving from the banner,
         without opening the app and hijacking whatever is on screen. */
      if (typeof deps.onAction === 'function') {
        const handled = deps.onAction(payload);
        if (handled === true) return;
        if (handled && typeof handled.then === 'function') {
          void handled.then((done) => {
            if (done || !active) return;
            deps.navigate(deps.router.resolveAction(payload, recipient));
          }).catch(() => undefined);
          return;
        }
      }
      deps.navigate(deps.router.resolveAction(payload, recipient));
    }

    const subscriptions = [];
    try {
      subscriptions.push(deps.notifications.addNotificationReceivedListener(() => {
        /* The foreground handler already presents it. Scheduling a local copy
           here is how a notification arrives twice. */
      }));
      subscriptions.push(deps.notifications.addNotificationResponseReceivedListener(handle));
      subscriptions.push(deps.notifications.addPushTokenListener(() => {
        /* The raw APNs/FCM token is of no use to us: the same silent path that
           runs at startup fetches a fresh one and registers it. */
        void sync();
      }));
    } catch (error) {
      for (const subscription of subscriptions) subscription.remove();
      throw error;
    }

    if (!coldStartHandled) {
      coldStartHandled = true;
      void (async () => {
        try {
          const response = await deps.notifications.getLastNotificationResponseAsync();
          if (!response) return;
          const id = response.notification && response.notification.request
            ? response.notification.request.identifier
            : null;
          if (id) {
            const handled = await deps.keystore.getItemAsync(handledKey);
            if (handled === id) return;
            await deps.keystore.setItemAsync(handledKey, id);
          }
          handle(response);
        } finally {
          try {
            await deps.notifications.clearLastNotificationResponseAsync();
          } catch {
            /* best effort: the persisted mark is what actually prevents replay */
          }
        }
      })().catch(() => undefined);
    }

    return () => {
      active = false;
      for (const subscription of subscriptions) subscription.remove();
    };
  }

  /**
   * Sign out, push cleanup included.
   * @param {Function} signOut  The app's own sign-out. Always called, last.
   */
  function logout(signOut) {
    if (logoutPromise) return logoutPromise;

    logoutInProgress = true;
    registrationBlocked = true;

    const operation = (async () => {
      await Promise.allSettled([...inFlight]);
      try {
        await unregister();
      } catch {
        /* signing out offline must stay possible */
      }
      try {
        /* An account can sign in on a phone that already received a
           notification for ANOTHER account. Without this, the next launch
           replays it and opens someone else's content. */
        const deps = await load();
        if (supported(deps)) await deps.notifications.clearLastNotificationResponseAsync();
      } catch {
        /* cleanup must never hold sign-out hostage */
      }
      coldStartHandled = false;
      if (typeof signOut === 'function') await signOut();
    })();

    logoutPromise = operation.finally(() => {
      logoutInProgress = false;
      logoutPromise = null;
    });
    return logoutPromise;
  }

  return {
    getInstallationId,
    getState,
    enable,
    sync,
    disable,
    unregister,
    allowRegistration,
    startListeners,
    logout
  };
}

module.exports = { createPushService, readPermission };
