/**
 * The middleware that turns a plan into a closed door.
 *
 * Everything that varies between products is injected. Astratra does not know
 * where an account's plan lives, which roles bypass billing, or whether a
 * feature is switched off network-wide for maintenance — so it asks.
 */
const DEFAULT_DENIED_STATUS = 403;

function messageFor({ feature, planLabel, upgradeLabel }) {
  const suffix = upgradeLabel ? ` Upgrade to ${upgradeLabel} to unlock it.` : '';
  return `"${feature}" is not included in the ${planLabel} plan.${suffix}`;
}

/**
 * @param {object} options
 * @param {object} options.catalog        from createPlanCatalog().
 * @param {Function} options.resolveAccount async (req) => { plan, overrides? } | null.
 *   Returning null means "no account to bill" and lets the request through —
 *   that is the shape of a public or platform-level route.
 * @param {Function} [options.isExempt]   (req) => boolean. Roles that never pay.
 * @param {Function} [options.isEnabled]  async (feature) => boolean. A global
 *   kill switch, checked before the plan: maintenance is not a billing matter.
 * @param {Function} [options.respond]    (res, { status, message, details }) => void.
 * @param {"allow"|"deny"} [options.onError]  what to do when a lookup throws.
 *   Defaults to "deny". A guard that opens on failure is a guard an attacker
 *   only has to break, not defeat — but a product may legitimately prefer to
 *   stay up rather than stay shut. Choose deliberately.
 * @param {Function} [options.onErrorLog] (error, feature) => void.
 */
function createFeatureGuard(options = {}) {
  const catalog = options.catalog;
  if (!catalog || typeof catalog.hasFeature !== 'function') {
    throw new Error('createFeatureGuard requires options.catalog from createPlanCatalog().');
  }

  const resolveAccount = options.resolveAccount;
  if (typeof resolveAccount !== 'function') {
    throw new Error('createFeatureGuard requires options.resolveAccount.');
  }

  const isExempt = options.isExempt || (() => false);
  const isEnabled = options.isEnabled || null;
  const onError = options.onError === 'allow' ? 'allow' : 'deny';
  const onErrorLog = options.onErrorLog || (() => {});

  const respond = options.respond || ((res, payload) => {
    res.status(payload.status).json({ success: false, message: payload.message, data: payload.details });
  });

  /**
   * @param {string} feature the key this route requires.
   */
  return function guard(feature) {
    if (typeof feature !== 'string' || !feature.trim()) {
      throw new Error('featureGuard(feature) requires a non-empty feature key.');
    }

    return async function featureGuardMiddleware(req, res, next) {
      try {
        if (isExempt(req)) return next();

        /* The kill switch first. A feature taken down for maintenance is
           unavailable to everyone, including the plan that pays for it —
           answering "upgrade your plan" there would be a lie. */
        if (isEnabled && !(await isEnabled(feature))) {
          return respond(res, {
            status: DEFAULT_DENIED_STATUS,
            message: `"${feature}" is temporarily unavailable. Please try again later.`,
            details: { feature, reason: 'disabled' }
          });
        }

        const account = await resolveAccount(req);
        if (!account) return next();

        const plan = account.plan;
        const overrides = account.overrides || [];
        if (catalog.hasFeature(plan, feature, overrides)) return next();

        const upgradeTo = catalog.upgradeFrom(plan);
        return respond(res, {
          status: DEFAULT_DENIED_STATUS,
          message: messageFor({
            feature,
            planLabel: catalog.labelOf(plan),
            upgradeLabel: upgradeTo ? catalog.labelOf(upgradeTo) : null
          }),
          details: { feature, currentPlan: plan, upgradeTo, reason: 'plan' }
        });
      } catch (error) {
        onErrorLog(error, feature);
        if (onError === 'allow') return next();
        return respond(res, {
          status: DEFAULT_DENIED_STATUS,
          message: `"${feature}" could not be verified right now. Please try again.`,
          details: { feature, reason: 'error' }
        });
      }
    };
  };
}

module.exports = { createFeatureGuard };
