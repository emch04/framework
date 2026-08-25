/**
 * Who may open which screen.
 *
 * Distinct from features, and the distinction matters: a feature is something
 * the account PAYS for, a screen is something a person is ALLOWED to see. The
 * finance page can be included in the plan and still be none of a teacher's
 * business.
 *
 * Kept as one table because the alternative — a role check scattered across
 * forty route files and forty components — is the thing that drifts. One table
 * can be read, reviewed, and tested.
 */

/**
 * @param {object} options
 * @param {Record<string, string[]>} options.screens screen key -> roles allowed.
 * @param {string[]} [options.superRoles] roles that open every screen.
 */
function createAccessMatrix(options = {}) {
  const screens = options.screens || {};
  if (!Object.keys(screens).length) {
    throw new Error('createAccessMatrix requires at least one screen in options.screens.');
  }

  const table = new Map();
  for (const [screen, roles] of Object.entries(screens)) {
    if (!Array.isArray(roles)) {
      throw new Error(`createAccessMatrix expects options.screens.${screen} to be an array of roles.`);
    }
    table.set(screen, new Set(roles));
  }

  const superRoles = new Set(options.superRoles || []);

  /**
   * An unknown screen is CLOSED, not open.
   *
   * The other way round is how a screen ships without anyone noticing it was
   * never added to the table — visible to everyone, quietly.
   */
  function canAccess(screen, role) {
    if (superRoles.has(role)) return true;
    const allowed = table.get(screen);
    if (!allowed) return false;
    return allowed.has(role);
  }

  return {
    screens: [...table.keys()],
    knows: (screen) => table.has(screen),
    canAccess,
    rolesFor: (screen) => (table.has(screen) ? [...table.get(screen)] : []),
    /** Every screen this role may open — what a navigation menu needs. */
    screensFor: (role) => [...table.keys()].filter((screen) => canAccess(screen, role)),
    /** Every role the table mentions — useful to catch a typo in a role name. */
    allRoles: () => [...new Set([...superRoles, ...[...table.values()].flatMap((set) => [...set])])]
  };
}

/**
 * Build a role list by subtraction.
 *
 * Access tables are almost always written as "everyone except…", and spelling
 * out the remainder by hand is how one role gets forgotten in one row.
 */
function except(roles, ...excluded) {
  const drop = new Set(excluded.flat());
  return roles.filter((role) => !drop.has(role));
}

module.exports = { createAccessMatrix, except };
