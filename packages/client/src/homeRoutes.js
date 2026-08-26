/**
 * Where each role lands once signed in.
 *
 * Without this table everyone fell back to the PUBLIC landing page — the one
 * that offers to sign in. People were therefore bounced to the sign-in screen
 * a second later, immediately after authenticating, with no explanation.
 *
 * The fallback must stay a page an unknown role may legitimately see. Pointing
 * it at a staff dashboard turns a mapping oversight into an access leak.
 */

/**
 * @param {object} options
 * @param {Object<string,string>} options.routes  role => path.
 * @param {string} options.fallback  Where an unmapped role goes.
 */
function createHomeRoutes(options = {}) {
  const routes = options.routes || {};
  const fallback = options.fallback;
  if (typeof fallback !== 'string' || !fallback) {
    throw new Error('createHomeRoutes requires options.fallback.');
  }

  return {
    routes,
    fallback,
    forRole(role) {
      if (!role) return fallback;
      return routes[role] || fallback;
    }
  };
}

module.exports = { createHomeRoutes };
