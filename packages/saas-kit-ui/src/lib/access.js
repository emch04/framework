/**
 * Who sees which screen. The server stays the authority (every admin route
 * answers 403 on its own); the UI only stops offering a member screens that
 * would fail, and never renders them.
 */
export const DEFAULT_ADMIN_ROLES = Object.freeze(['owner', 'admin']);
export const DEFAULT_OWNER_ROLES = Object.freeze(['owner']);

/** null: any signed-in person. 'admin': one of the admin roles. */
export const VIEW_ACCESS = Object.freeze({ dashboard: null, users: 'admin', settings: 'admin' });

export function canSeeView(view, user, { adminRoles = DEFAULT_ADMIN_ROLES } = {}) {
  if (!user || !Object.prototype.hasOwnProperty.call(VIEW_ACCESS, view)) return false;
  const need = VIEW_ACCESS[view];
  return need === null || (need === 'admin' && adminRoles.includes(user.role));
}

export function visibleViews(user, options) {
  return Object.keys(VIEW_ACCESS).filter((view) => canSeeView(view, user, options));
}

/** The roles a person may hand out from the Users screen: admin roles are for owners only (same rule as the server). */
export function assignableRoles(user, { adminRoles = DEFAULT_ADMIN_ROLES, ownerRoles = DEFAULT_OWNER_ROLES, roles = ['member', 'admin', 'owner'] } = {}) {
  if (!user || !adminRoles.includes(user.role)) return [];
  return ownerRoles.includes(user.role) ? [...roles] : roles.filter((role) => !adminRoles.includes(role));
}
