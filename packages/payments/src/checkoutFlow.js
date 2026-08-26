/**
 * The client side of paying: which plan a button may buy, where to send the
 * person, and how to decide the payment went through.
 *
 * None of this is gateway-specific — and that is the point. Two gateways name
 * the same things differently, answer confirmation differently, and a screen
 * should not know which one is behind it.
 *
 * Three rules were each written after a real complaint.
 *
 * A PLAN CAN BE GRANTED RATHER THAN SOLD. A trial is handed out when the
 * account is created; offering to buy it produces an error from the server and
 * bewilderment from the person. Such plans are declared unpurchasable.
 *
 * AN ACCOUNT WITH NOTHING TO BILL MUST BE TOLD. The pay button used to check
 * "no account id" and return — no request, no message, nothing. A button that
 * does nothing reads as a breakage; this is a normal situation and deserves a
 * sentence.
 *
 * "PENDING" IS NOT "FAILED". When polling gives up, the payment may well have
 * gone through: the webhook will settle it. Telling someone their payment
 * failed while their money is on its way is the worst possible answer.
 */

const DEFAULT_MAX_CONFIRMATION_ATTEMPTS = 24;
const DEFAULT_CONFIRMATION_INTERVAL_MS = 5000;
const CHECKOUT_URL_FIELDS = ['checkoutUrl', 'paymentUrl', 'url'];

/**
 * The hosted payment page, whichever field the gateway used.
 * @param {string[]} [fields] Extra names, for a gateway that invents its own.
 */
function readCheckoutUrl(payload, fields = CHECKOUT_URL_FIELDS) {
  if (!payload || typeof payload !== 'object') return null;
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * An id that arrives raw on one route and populated on another.
 *
 * Both must yield the same string, or a request goes out carrying
 * "[object Object]" and fails somewhere far from the cause.
 */
function readEntityId(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const id = value._id ?? value.id;
    if (typeof id === 'string') return id;
  }
  return '';
}

/** A gateway epoch, in seconds, as a date. Absent or nonsensical: no date. */
function readRenewalDate(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/**
 * @param {object} [options]
 * @param {string[]} [options.notPurchasable]  Plans granted, never sold.
 * @param {string} [options.defaultPlan]  What "no plan" means. Default ''.
 * @param {number} [options.maxAttempts]
 * @param {number} [options.intervalMs]
 * @param {Object<string,Function>} [options.confirms]  gateway => (payload) => boolean.
 */
function createCheckoutFlow(options = {}) {
  const notPurchasable = new Set(options.notPurchasable || []);
  const defaultPlan = options.defaultPlan || '';
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_CONFIRMATION_ATTEMPTS;
  const intervalMs = options.intervalMs || DEFAULT_CONFIRMATION_INTERVAL_MS;
  const confirms = options.confirms || {};

  /** @returns {'current'|'locked'|'choose'} */
  function planAction(planKey, currentPlanKey) {
    if (planKey === (currentPlanKey || defaultPlan)) return 'current';
    if (notPurchasable.has(planKey)) return 'locked';
    return 'choose';
  }

  return {
    maxAttempts,
    intervalMs,

    planAction,

    isSelectable(planKey, currentPlanKey) {
      return planAction(planKey, currentPlanKey) === 'choose';
    },

    /** Is there anything to bill at all? */
    canPay(accountId) {
      return typeof accountId === 'string' && accountId.length > 0;
    },

    /** @returns {'confirmed'|'retry'|'pending'} */
    nextPoll({ confirmed, attempts } = {}) {
      if (confirmed) return 'confirmed';
      return Number(attempts) >= maxAttempts ? 'pending' : 'retry';
    },

    /**
     * Did this gateway say the payment is done?
     * An undeclared gateway is NEVER confirmed: silence must not grant access.
     */
    isConfirmed(gateway, payload) {
      const read = confirms[gateway];
      if (typeof read !== 'function') return false;
      try {
        return read(payload) === true;
      } catch {
        return false;
      }
    }
  };
}

module.exports = {
  CHECKOUT_URL_FIELDS,
  DEFAULT_CONFIRMATION_INTERVAL_MS,
  DEFAULT_MAX_CONFIRMATION_ATTEMPTS,
  createCheckoutFlow,
  readCheckoutUrl,
  readEntityId,
  readRenewalDate
};
