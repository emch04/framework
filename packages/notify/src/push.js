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
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_TIMEOUT_MS = 30_000;

function withTimeout(value, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Push delivery timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(value), deadline]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} options
 * @param {Function} options.transport  async (subscription, payload) => any.
 *   webpush.sendNotification, Expo's client, your own — must THROW on failure
 *   with the provider's status reachable on the error.
 * @param {Function} [options.isGone]  (error) => boolean. Default: 404 or 410.
 * @param {Function} [options.onGone] async (subscription) => void — delete it
 *   from your store. THIS is the point of the module.
 * @param {number} [options.concurrency=10] Maximum simultaneous sends.
 * @param {number} [options.timeoutMs=30000] Provider deadline for one send.
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
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('createPushSender options.concurrency must be a positive integer.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('createPushSender options.timeoutMs must be a positive integer.');
  }

  /**
   * Send to ONE subscription.
   * @returns {Promise<{status: 'delivered'|'gone'|'failed', error?: string}>} never throws.
   */
  async function send(subscription, payload) {
    try {
      await withTimeout(transport(subscription, payload), timeoutMs);
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
   * Send to MANY. Awaiting each send in sequence let one slow provider hold
   * every later subscription for hours. Bounded workers isolate that defect
   * without replacing it with an unbounded provider spike.
   */
  async function broadcast(subscriptions, payload) {
    const report = { delivered: 0, gone: 0, failed: 0, errors: [] };
    const items = subscriptions || [];
    const outcomes = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        outcomes[index] = await send(items[index], payload);
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker()
    ));

    /* Completion order is nondeterministic. Aggregate by input index so an
       operator can still match each reported failure to the original batch. */
    for (const outcome of outcomes) {
      report[outcome.status] += 1;
      if (outcome.status === 'failed' && report.errors.length < 10) report.errors.push(outcome.error);
    }
    return report;
  }

  return { send, broadcast };
}

module.exports = { createPushSender };
