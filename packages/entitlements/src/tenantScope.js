/**
 * Keeping one tenant's data out of another tenant's queries.
 *
 * Every multi-tenant query must carry the tenant filter, and forgetting it
 * once shows one school the students of another. The scope centralises the
 * decision — and, above all, decides what happens when the tenant is MISSING.
 *
 * The rule that matters: NO TENANT MEANS NO ROWS, not all rows. A user whose
 * account carries no tenant — a half-migrated record, a token minted before a
 * schema change — gets a filter that can never match, instead of an unscoped
 * query that returns everyone's data. Fail closed.
 */

/**
 * @param {object} options
 * @param {string} options.field  the tenant field on your documents — 'school',
 *   'organisation', 'shopId'…
 * @param {string[]} [options.globalRoles] roles that see across tenants.
 * @param {Function} [options.tenantOf]  (user) => tenant id. Default: user[field].
 * @param {*} [options.impossibleValue] what a no-tenant filter matches on.
 *   Default: a sentinel string no real id ever equals. Pass an impossible
 *   ObjectId if your store compares types strictly.
 * @param {Function} [options.onMissingTenant] (user) => void — a user with no
 *   tenant is worth an alarm, not just an empty screen.
 */
function createTenantScope(options = {}) {
  const field = options.field;
  if (typeof field !== 'string' || !field.trim()) {
    throw new Error('createTenantScope requires options.field — the tenant field on your documents.');
  }

  const globalRoles = new Set(options.globalRoles || []);
  const tenantOf = options.tenantOf || ((user) => user && user[field]);
  const impossibleValue = 'impossibleValue' in options
    ? options.impossibleValue
    : '__no_tenant_matches_nothing__';
  const onMissingTenant = options.onMissingTenant || (() => {});

  /**
   * Add the tenant filter to a query.
   *
   * @param {object|null} user
   * @param {object} [query]
   * @returns {object} a NEW object — the input is never mutated.
   */
  function scope(user, query = {}) {
    if (user && globalRoles.has(user.role)) return { ...query };

    const tenant = tenantOf(user);
    if (tenant === undefined || tenant === null || tenant === '') {
      /* Fail CLOSED. An unscoped query here would be the cross-tenant leak
         this module exists to prevent — and it would look like a feature. */
      onMissingTenant(user);
      return { ...query, [field]: impossibleValue };
    }

    return { ...query, [field]: tenant };
  }

  /** May this user read a document carrying this tenant value? */
  function canAccess(user, documentTenant) {
    if (user && globalRoles.has(user.role)) return true;
    const tenant = tenantOf(user);
    if (tenant === undefined || tenant === null || tenant === '') return false;
    return String(tenant) === String(documentTenant);
  }

  return { scope, canAccess, field };
}

module.exports = { createTenantScope };
