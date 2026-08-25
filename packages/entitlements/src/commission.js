/**
 * What the platform keeps on a transaction, by plan.
 *
 * Small enough to look unnecessary, until the rate lives in four files and
 * two of them disagree. Rates are yours; the arithmetic and the rounding are
 * the part worth sharing.
 */

/**
 * @param {object} options
 * @param {number} options.defaultRate      e.g. 0.01 for one percent.
 * @param {Record<string, number>} [options.rates] plan -> rate, overriding the default.
 * @param {Function} [options.round]        (amount) => number. Defaults to
 *   rounding to whole minor units, which is what a payment processor accepts.
 */
function createCommissionSchedule(options = {}) {
  const defaultRate = options.defaultRate;
  if (typeof defaultRate !== 'number' || !Number.isFinite(defaultRate) || defaultRate < 0) {
    throw new Error('createCommissionSchedule requires a non-negative numeric options.defaultRate.');
  }

  const rates = options.rates || {};
  for (const [plan, rate] of Object.entries(rates)) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw new Error(`createCommissionSchedule: rate for "${plan}" must be a non-negative number.`);
    }
  }

  /* Money is counted in whole minor units — cents, centimes. Leaving a
     fraction of a cent in a transfer is how a ledger stops balancing. */
  const round = options.round || ((amount) => Math.round(amount));

  const rateFor = (plan) => (Object.prototype.hasOwnProperty.call(rates, plan) ? rates[plan] : defaultRate);

  /**
   * @returns {{rate: number, commission: number, net: number}} all in the
   * same minor units as `amount`.
   */
  function commissionOn(amount, plan) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new Error('commissionOn requires a non-negative numeric amount.');
    }
    const rate = rateFor(plan);
    const commission = round(amount * rate);
    return { rate, commission, net: amount - commission };
  }

  return { defaultRate, rateFor, commissionOn };
}

module.exports = { createCommissionSchedule };
