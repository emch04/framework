/**
 * Push notifications, and the lesson that matters: DEAD SUBSCRIPTIONS.
 *
 * A push subscription dies quietly — the app is uninstalled, permissions
 * revoked, the browser profile wiped. The provider answers 404 or 410, and
 * from then on every send to that subscription fails, forever. Left alone, a
 * subscriber list only accumulates corpses: sends get slower, error logs fill
 * with noise that buries real failures, and some providers throttle senders
 * whose failure rate climbs.
 *
 * So a dead subscription is not an error to log — it is a FACT to act on. The
 * dispatcher separates the three outcomes and hands the dead ones back for
 * pruning.
 */

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * @param {object} options
 * @param {Function} options.transport  async (subscription, payload) => any.
 *   webpush.sendNotification, Expo's client, your own — must THROW on failure
 *   with the provider's status reachable on the error.
 * @param {Function} [options.isGone]  (error) => boolean. Default: 404 or 410.
 * @param {Function} [options.onGone] async (subscription) => void — delete it
 *   from your store. THIS is the point of the module.
 * @param {object} [options.logger]
 */
function createPushSender(options = {}) {
  const transport = options.transport;
  if (typeof transport !== 'function') {
    throw new Error('createPushSender requires options.transport.');
  }

  const isGone = options.isGone || ((error) => {
    const status = Number(error?.statusCode ?? error?.status ?? error?.response?.status);
    return status === 404 || status === 410;
  });
  const onGone = options.onGone || null;
  const logger = options.logger || NOOP_LOGGER;

  /**
   * Send to ONE subscription.
   * @returns {Promise<{status: 'delivered'|'gone'|'failed', error?: string}>} never throws.
   */
  async function send(subscription, payload) {
    try {
      await transport(subscription, payload);
      return { status: 'delivered' };
    } catch (error) {
      if (isGone(error)) {
        /* Not an error: a fact. The subscription is dead and will never
           deliver again — prune it, or send to it forever. */
        if (onGone) {
          try {
            await onGone(subscription);
          } catch (pruneError) {
            logger.error(`[push] could not prune a dead subscription: ${pruneError.message}`);
          }
        }
        return { status: 'gone' };
      }
      logger.error(`[push] delivery failed: ${error.message}`);
      return { status: 'failed', error: error.message };
    }
  }

  /**
   * Send to MANY. One dead or failing subscription must not stop the others —
   * the report says how many of each, and failures carry their reasons.
   */
  async function broadcast(subscriptions, payload) {
    const report = { delivered: 0, gone: 0, failed: 0, errors: [] };
    for (const subscription of subscriptions || []) {
      const outcome = await send(subscription, payload);
      report[outcome.status] += 1;
      if (outcome.status === 'failed' && report.errors.length < 10) report.errors.push(outcome.error);
    }
    return report;
  }

  return { send, broadcast };
}

module.exports = { createPushSender };
