/**
 * Staying signed in without the user noticing.
 *
 * Access tokens expire on purpose — short-lived tokens are what limits the
 * damage of a stolen one. The price is that every client must handle the
 * moment of expiry: catch the 401, refresh the session, replay the request,
 * and do all of it without the user seeing a login screen in the middle of
 * saving their work.
 *
 * Every client rebuilds this, and the same three bugs come back every time:
 *
 *   THE REFRESH STAMPEDE. Five requests fail together when the token dies;
 *   five refresh calls race, and four consume a rotated refresh token that is
 *   no longer valid — logging the user out at the exact moment everything was
 *   recoverable. The refresh must be SINGLE-FLIGHT: one call, everyone else
 *   awaits it.
 *
 *   THE INFINITE LOOP. The refresh endpoint itself answers 401, the client
 *   tries to refresh, which answers 401… Endpoints that must never trigger a
 *   refresh are excluded by name.
 *
 *   THE SILENT REPLAY OF THE WRONG THING. A request is replayed ONCE after a
 *   successful refresh. If it fails again, that is a real answer, not a token
 *   problem.
 *
 * Transport and storage are injected: axios or fetch, cookie or SecureStore,
 * web or mobile — same logic.
 */

class SessionExpiredError extends Error {
  constructor(cause) {
    super('The session has expired and could not be renewed.');
    this.name = 'SessionExpiredError';
    this.code = 'SESSION_EXPIRED';
    this.cause = cause || null;
  }
}

/**
 * @param {object} options
 * @param {Function} options.request  async (path, init) => response. Yours.
 *   Must THROW (or reject) with an error carrying `status` on HTTP failure.
 * @param {Function} options.refresh  async () => void. Renews the session —
 *   posts the refresh token, updates storage. Must throw when it cannot.
 * @param {string[]} [options.excluded] paths that never trigger a refresh.
 *   The refresh and login endpoints belong here.
 * @param {Function} [options.onSessionExpired] called once per definitive
 *   expiry — the place to clear storage and route to the login screen.
 * @param {Function} [options.isAuthError] (error) => boolean. Default: status === 401.
 */
function createSessionClient(options = {}) {
  const request = options.request;
  if (typeof request !== 'function') {
    throw new Error('createSessionClient requires options.request.');
  }
  const refresh = options.refresh;
  if (typeof refresh !== 'function') {
    throw new Error('createSessionClient requires options.refresh.');
  }

  const excluded = new Set(options.excluded || []);
  const onSessionExpired = options.onSessionExpired || null;
  const isAuthError = options.isAuthError || ((error) => error && error.status === 401);

  /* The single flight. Everybody who hits a 401 while a refresh is running
     awaits the SAME promise — one refresh-token spend, not five. */
  let inFlight = null;

  function refreshOnce() {
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(refresh)
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  /**
   * Make a request; on an auth failure, refresh and replay it once.
   */
  async function call(path, init) {
    try {
      return await request(path, init);
    } catch (error) {
      if (!isAuthError(error) || excluded.has(path)) throw error;

      try {
        await refreshOnce();
      } catch (refreshError) {
        /* Definitively out. Announce it ONCE, then surface a typed error the
           interface can route on. */
        if (onSessionExpired) {
          try { onSessionExpired(refreshError); } catch { /* the handler must not mask the expiry */ }
        }
        throw new SessionExpiredError(refreshError);
      }

      /* Once. A second 401 after a fresh session is a real answer —
         a permission, not a token. */
      return request(path, init);
    }
  }

  return { call, refreshOnce, SessionExpiredError };
}

module.exports = { createSessionClient, SessionExpiredError };
