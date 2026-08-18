function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Mutates in place rather than reassigning req.body/req.query/req.params —
// req.query in particular is a getter-only property on some Express/router
// setups, so `req.query = clean` silently breaks in ways that are easy to
// miss in dev and only surface under a specific framework version.
function stripDangerousKeys(value, replaceWith) {
  if (Array.isArray(value)) {
    value.forEach((item) => stripDangerousKeys(item, replaceWith));
    return value;
  }
  if (!isPlainObject(value)) return value;

  for (const key of Object.keys(value)) {
    // `$`-prefixed keys are Mongo query operators ($gt, $where, $ne...);
    // dotted keys reach into nested/array fields ("services.0.date"). Either
    // one, if it survives from req.query/req.body into a driver call like
    // Model.find({ date }), turns a simple equality filter the app wrote
    // into an attacker-chosen query — found via a real consumer route that
    // passed `date` from req.query straight into a Mongoose filter, letting
    // `?date[$gt]=` (Express's default `qs` parser turns bracket notation
    // into a nested object) return every document instead of one day's.
    if (key.startsWith('$') || key.includes('.')) {
      const original = value[key];
      delete value[key];
      if (replaceWith !== undefined) value[replaceWith] = original;
      continue;
    }
    stripDangerousKeys(value[key], replaceWith);
  }
  return value;
}

const DEFAULT_TARGETS = ['body', 'query', 'params'];

/**
 * Strips Mongo operator injection out of req.body/req.query/req.params
 * before it reaches a database call — see stripDangerousKeys() for the bug
 * this closes. Safe as a blanket default: no legitimate REST client sends a
 * literal `$`-prefixed or dotted JSON key, so there's no plausible request
 * this rejects that a normal client would ever send.
 *
 * createMongoSanitizeMiddleware({ replaceWith: '_blocked' }) keeps the
 * offending value under a renamed key instead of dropping it silently, if a
 * consumer wants to log/inspect what was stripped.
 */
const createMongoSanitizeMiddleware = (options = {}) => {
  const targets = options.targets || DEFAULT_TARGETS;
  const replaceWith = options.replaceWith;

  return (req, res, next) => {
    for (const target of targets) {
      if (req[target] && typeof req[target] === 'object') {
        stripDangerousKeys(req[target], replaceWith);
      }
    }
    return next();
  };
};

module.exports = { createMongoSanitizeMiddleware };
