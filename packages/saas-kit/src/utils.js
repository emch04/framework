const DEFAULT_PUBLIC_USER_FIELDS = ['id', 'email', 'role'];
const SENSITIVE_USER_FIELDS = new Set(['password', 'passwordHash', 'hash', 'salt', 'tokens']);

function pickPublicUser(user, fields = DEFAULT_PUBLIC_USER_FIELDS) {
  if (!user) return null;

  return fields.reduce((publicUser, field) => {
    if (!SENSITIVE_USER_FIELDS.has(field) && Object.prototype.hasOwnProperty.call(user, field)) {
      publicUser[field] = user[field];
    }
    return publicUser;
  }, {});
}

function sanitizeUser(user) {
  if (!user) return null;

  return Object.entries(user).reduce((safeUser, [key, value]) => {
    if (!SENSITIVE_USER_FIELDS.has(key)) {
      safeUser[key] = value;
    }
    return safeUser;
  }, {});
}

function assertAdapter(adapter, methods, name) {
  for (const method of methods) {
    if (!adapter || typeof adapter[method] !== 'function') {
      throw new Error(`createSaasApp requires ${name}.${method}.`);
    }
  }
}

function toPagination(query = {}) {
  return {
    role: query.role,
    limit: query.limit ? Number(query.limit) : 50,
    offset: query.offset ? Number(query.offset) : 0
  };
}

module.exports = {
  DEFAULT_PUBLIC_USER_FIELDS,
  assertAdapter,
  pickPublicUser,
  sanitizeUser,
  toPagination
};
