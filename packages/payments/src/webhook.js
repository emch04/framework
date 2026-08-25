/**
 * The pipeline every payment webhook needs, and that everyone rebuilds badly.
 *
 * Four traps, each of which silently kills payments while the code looks fine:
 *
 *   1. THE RAW BODY. Signature verification runs on the exact bytes the
 *      provider signed. A JSON body parser rewrites them, so verification
 *      fails even with the correct secret — and the error says "invalid
 *      signature", which sends you hunting for the wrong bug.
 *
 *   2. THE MIDDLEWARE STACK. CSRF returns 403 to a provider that has no cookie
 *      to send. Auth guards reject a caller that is not a user. Rate limiters
 *      throttle a burst of retries. Each layer must exempt the webhook, and
 *      forgetting one is invisible until money goes missing.
 *
 *   3. "NOT MINE" ANSWERED WITH 404. Webhooks are account-scoped: one endpoint
 *      receives events from every flow on the account. A 404 makes the provider
 *      retry for days and mark the endpoint failing — for events that were
 *      never yours.
 *
 *   4. A FAILED SIDE EFFECT FAILING THE WEBHOOK. The money is taken and the
 *      order is confirmed; if the confirmation email then throws, returning 500
 *      asks the provider to send the whole event again. The side effect must
 *      fail alone.
 *
 * This module handles 1, 3 and 4. Trap 2 is `createWebhookExemption` next door,
 * because only your app knows its own middleware.
 */
const { isOutcome, handled, unrelated, duplicate, HANDLED, UNRELATED, DUPLICATE, IGNORED } = require('./outcomes');

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

const resolve = async (value) => (typeof value === 'function' ? value() : value);

/**
 * @param {object} options
 * @param {Function} options.verify  ({ payload, headers, secret }) => event.
 *   Yours, because it is provider-specific — typically
 *   `stripe.webhooks.constructEvent(payload, headers['stripe-signature'], secret)`.
 *   It MUST throw when the signature does not check out.
 * @param {*} [options.secret]  the signing secret, or a function returning it.
 *   A function is read on every call, so the secret can be rotated from an
 *   interface without a restart.
 * @param {Record<string, Function>} options.events  event type -> handler.
 *   An event type absent from this map is acknowledged, never rejected.
 * @param {object} [options.eventLog]  { seen, record } — replay protection.
 * @param {Function} [options.eventId] (event) => string. Defaults to `event.id`.
 * @param {object} [options.logger]
 */
function createWebhookHandler(options = {}) {
  const verify = options.verify;
  if (typeof verify !== 'function') {
    throw new Error('createWebhookHandler requires options.verify.');
  }

  const events = options.events || {};
  if (!Object.keys(events).length) {
    throw new Error('createWebhookHandler requires at least one entry in options.events.');
  }

  const eventLog = options.eventLog || null;
  const eventIdOf = options.eventId || ((event) => event && event.id);
  const logger = options.logger || NOOP_LOGGER;

  /**
   * Run something that must NOT be able to fail the webhook.
   *
   * Emails, notifications, analytics: the payment is already taken and the
   * order already confirmed. A throw here would return 500 and ask the provider
   * to replay an event that was, in fact, handled.
   */
  async function sideEffect(label, fn) {
    try {
      return await fn();
    } catch (error) {
      logger.error(`[payments] side effect "${label}" failed after the event was handled: ${error.message}`);
      return null;
    }
  }

  /**
   * @param {object} request { payload, headers }
   * @returns {{status: number, body: object}} ready to send.
   */
  async function receive(request = {}) {
    const secret = await resolve(options.secret);

    let event;
    try {
      event = await verify({ payload: request.payload, headers: request.headers || {}, secret });
    } catch (error) {
      /* 400, never 500: the provider must NOT retry a payload it signed wrong
         or that we cannot verify — retrying would change nothing. */
      logger.warn(`[payments] signature rejected: ${error.message}`);
      return { status: 400, body: { received: false, reason: 'invalid-signature' } };
    }

    if (!event || !event.type) {
      return { status: 400, body: { received: false, reason: 'malformed-event' } };
    }

    const id = eventIdOf(event);

    if (eventLog && id && (await eventLog.seen(id))) {
      logger.info(`[payments] ${event.type} ${id} already handled — acknowledged again`);
      return { status: 200, body: { received: true, status: DUPLICATE } };
    }

    const handler = events[event.type];
    if (!handler) {
      /* Not an error. One endpoint receives everything the account emits, and
         most of it belongs to flows this code knows nothing about. */
      logger.info(`[payments] ${event.type} acknowledged — no handler, not an error`);
      return { status: 200, body: { received: true, status: IGNORED, type: event.type } };
    }

    let outcome;
    try {
      outcome = await handler(event, { sideEffect, handled, unrelated, duplicate, logger });
    } catch (error) {
      /* A genuine failure: the provider SHOULD retry, so 500 is right here.
         This is the one case where retrying can help. */
      logger.error(`[payments] ${event.type} failed: ${error.message}`);
      return { status: 500, body: { received: false, reason: 'handler-failed' } };
    }

    const result = isOutcome(outcome) ? outcome : handled();

    if (eventLog && id && result.status === HANDLED) {
      await sideEffect('event log', () => eventLog.record(id, { type: event.type }));
    }

    if (result.status === UNRELATED) {
      logger.info(`[payments] ${event.type} acknowledged as not ours${result.reason ? `: ${result.reason}` : ''}`);
    }

    return { status: 200, body: { received: true, status: result.status, type: event.type } };
  }

  /** The same pipeline, shaped as an express handler. */
  function middleware(req, res) {
    return receive({ payload: req.body, headers: req.headers }).then(({ status, body }) => {
      res.status(status).json(body);
    });
  }

  return { receive, middleware, sideEffect };
}

module.exports = { createWebhookHandler };
