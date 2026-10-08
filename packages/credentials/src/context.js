/** Scope and authenticated context are canonical, independent of property order. */
function normalizeScope(scope) {
  if (scope === undefined || scope === null) return null;
  if (typeof scope.tenant !== 'string' || !scope.tenant.trim() ||
      typeof scope.environment !== 'string' || !scope.environment.trim()) {
    throw new Error('A scope requires nonempty tenant and environment.');
  }
  return Object.freeze({ tenant: scope.tenant, environment: scope.environment });
}
function sameScope(row, scope) {
  return scope ? row.tenant === scope.tenant && row.environment === scope.environment
    : row.tenant == null && row.environment == null;
}
function rowId(key, scope) {
  return JSON.stringify([scope?.tenant ?? null, scope?.environment ?? null, key]);
}
function rowContext(row, scope) {
  return { tenant: scope?.tenant ?? null, environment: scope?.environment ?? null,
    name: row.key, version: row.version ?? 0 };
}
function contextBytes(context) {
  if (!context || typeof context.name !== 'string' || !context.name ||
      !Number.isSafeInteger(context.version) || context.version < 0 ||
      ![context.tenant, context.environment].every(v => v === null || (typeof v === 'string' && v.length > 0)) ||
      (context.tenant === null) !== (context.environment === null)) throw new Error('Invalid authenticated context.');
  return Buffer.from(JSON.stringify(['astratra.credentials.v1', context.tenant,
    context.environment, context.name, context.version]), 'utf8');
}
function versionMetadata(row) {
  return { key: row.key, ...(row.tenant == null ? {} : { tenant: row.tenant, environment: row.environment }),
    ...(row.version === undefined ? {} : { version: row.version }),
    updatedAt: row.updatedAt || null, updatedBy: row.updatedBy || null,
    retiredAt: row.retiredAt || null, expiresAt: row.expiresAt || null, purged: row.purged === true };
}
module.exports = { normalizeScope, sameScope, rowId, rowContext, contextBytes, versionMetadata };
