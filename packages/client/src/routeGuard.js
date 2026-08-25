/**
 * Which screens exist without a session.
 *
 * The bug this comes from: logging out replaced the TOP screen with the login
 * page — the whole navigation stack stayed underneath. Pressing back a few
 * times walked right back onto the dashboard, signed out but with the
 * student's data still on screen.
 *
 * Two decisions carry the fix:
 *
 *   THE LIST NAMES WHAT IS PUBLIC, and everything else is closed. A list of
 *   protected screens reads more naturally and fails silently: every screen
 *   added later and forgotten on the list ships open.
 *
 *   WHILE THE SESSION IS RESTORING, NOTHING IS DECIDED. At startup,
 *   "authenticated" is false before it becomes true; redirecting on that
 *   transient state ejects a perfectly signed-in user to the login screen on
 *   every cold start.
 */

/**
 * @param {object} options
 * @param {string[]} options.publicSegments  first URL segments reachable
 *   without a session — 'login', 'reset-password', a public landing…
 * @param {string} [options.loginRoute]  default '/login'.
 * @param {boolean} [options.emptyIsPublic]  what the bare root ('/') is.
 *   Default true: a splash screen decides for itself where to send people,
 *   the guard must not fight it while it works.
 */
function createRouteGuard(options = {}) {
  const publicSegments = options.publicSegments;
  if (!Array.isArray(publicSegments) || !publicSegments.length) {
    throw new Error('createRouteGuard requires options.publicSegments — the list names what is PUBLIC, everything else is closed.');
  }

  const publics = new Set(publicSegments);
  const loginRoute = options.loginRoute || '/login';
  const emptyIsPublic = options.emptyIsPublic !== false;

  /** @param {readonly string[]|string|null|undefined} route segments, or a path. */
  function segmentsOf(route) {
    if (Array.isArray(route)) return route;
    if (typeof route === 'string') return route.split('/').filter(Boolean);
    return [];
  }

  function isPublicRoute(route) {
    const first = segmentsOf(route)[0];
    if (!first) return emptyIsPublic;
    return publics.has(first);
  }

  /**
   * Should this navigation be sent to the login screen?
   *
   * @param {object} state { isLoading, isAuthenticated, route }
   */
  function shouldRedirectToLogin(state = {}) {
    if (state.isLoading) return false;
    if (state.isAuthenticated) return false;
    return !isPublicRoute(state.route);
  }

  return { isPublicRoute, shouldRedirectToLogin, loginRoute, publicSegments: [...publics] };
}

module.exports = { createRouteGuard };
