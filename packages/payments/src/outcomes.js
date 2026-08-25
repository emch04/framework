/**
 * What a webhook handler can conclude, and what each conclusion means to the
 * payment provider on the other end.
 *
 * The status code is not cosmetic here. A provider reads it as an instruction:
 * anything other than 2xx means "I did not get through, send it again", and
 * providers retry for days before marking the endpoint failing. Choosing the
 * wrong one is how a working integration starts looking broken.
 */

const HANDLED = 'handled';
const UNRELATED = 'unrelated';
const DUPLICATE = 'duplicate';
const IGNORED = 'ignored';

const OUTCOME = Symbol.for('astratra.payments.outcome');

const make = (status, reason) => ({ [OUTCOME]: true, status, reason: reason || null });

const isOutcome = (value) => Boolean(value && value[OUTCOME]);

/**
 * "Received, but not my circuit."
 *
 * Webhooks are scoped to the ACCOUNT, not to one flow. A single endpoint
 * therefore receives events belonging to other products, other checkouts, other
 * teams sharing the same provider account. Answering 404 to those makes the
 * provider retry them for days and eventually flag the endpoint as failing —
 * for events that were never yours to handle.
 *
 * Acknowledge them. They are somebody else's business, and saying so ends the
 * conversation politely.
 */
const unrelated = (reason) => make(UNRELATED, reason);

/**
 * Already done.
 *
 * Providers resend. A network blip on your side, a timeout, a manual replay
 * from their dashboard — the same event arrives twice, and the second time it
 * must not charge, refund or confirm anything again.
 */
const duplicate = (reason) => make(DUPLICATE, reason);

/** Handled, nothing more to say. */
const handled = (reason) => make(HANDLED, reason);

module.exports = { HANDLED, UNRELATED, DUPLICATE, IGNORED, OUTCOME, isOutcome, handled, unrelated, duplicate };
