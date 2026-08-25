/**
 * The door that closes on a whole account, not one feature.
 *
 * Suspension is a different question from entitlement: an unpaid or frozen
 * account loses everything at once, and telling those users to "upgrade their
 * plan" would be both wrong and insulting. Hence a separate guard.
 */
const DEFAULT_BLOCKED_STATUS = 403;

/**
 * @param {object} options
 * @param {Function} options.resolveStatus async (req) => { status, name?, reason? } | null.
 *   null lets the request through — nothing to suspend.
 * @param {string[]} [options.blockedStatuses] defaults to ['suspended'].
 * @param {Function} [options.isExempt]  (req) => boolean.
 * @param {Function} [options.message]   ({ status, name, reason }) => string.
 * @param {Function} [options.respond]   (res, payload) => void.
 * @param {"allow"|"deny"} [options.onError] defaults to "deny".
 * @param {Function} [options.onErrorLog]
 */
function createStatusGuard(options = {}) {
  const resolveStatus = options.resolveStatus;
  if (typeof resolveStatus !== 'function') {
    throw new Error('createStatusGuard requires options.resolveStatus.');
  }

  const blocked = new Set(options.blockedStatuses || ['suspended']);
  const isExempt = options.isExempt || (() => false);
  const onError = options.onError === 'allow' ? 'allow' : 'deny';
  const onErrorLog = options.onErrorLog || (() => {});

  const message = options.message || (({ status, name, reason }) => {
    const who = name ? `"${name}"` : 'This account';
    const why = reason ? ` Reason: ${reason}.` : '';
    return `${who} is ${status} and cannot be used right now.${why}`;
  });

  const respond = options.respond || ((res, payload) => {
    res.status(payload.status).json({ success: false, message: payload.message, data: payload.details });
  });

  return async function statusGuardMiddleware(req, res, next) {
    try {
      if (isExempt(req)) return next();

      const account = await resolveStatus(req);
      if (!account || !blocked.has(account.status)) return next();

      return respond(res, {
        status: DEFAULT_BLOCKED_STATUS,
        message: message(account),
        details: { status: account.status, reason: account.reason || null }
      });
    } catch (error) {
      onErrorLog(error);
      if (onError === 'allow') return next();
      return respond(res, {
        status: DEFAULT_BLOCKED_STATUS,
        message: 'Account status could not be verified right now. Please try again.',
        details: { reason: 'error' }
      });
    }
  };
}

module.exports = { createStatusGuard };
