/**
 * The tracking webhook of a carrier, on @astratra/payments' webhook pipeline:
 * raw-body signature check, atomic replay protection (claim → handle → record,
 * release on failure), side effects that cannot fail the webhook.
 *
 * The event id is the SHA-256 of the raw body: Sendcloud resends the same body,
 * so a resend is recognised whatever it contains. The package knows no orders
 * and no tables: the application says what a pickup, a delivery or an
 * incident means for it.
 *
 * Mount BEFORE any JSON body parser: the signature is computed on the exact
 * bytes received (express.raw({ type: 'application/json' })).
 */
const { createHash } = require('node:crypto');
const { createWebhookHandler } = require('@astratra/payments');

const SIGNATURE_HEADER = 'sendcloud-signature';
const DEFAULT_PRUNE_OLDER_THAN_MS = 90 * 24 * 3600_000;
const DEFAULT_PRUNE_EVERY_MS = 24 * 3600_000;

/**
 * @param {object} options
 * @param {object} options.carrier a Carrier (verifySignature, readEvent)
 * @param {object} [options.eventLog] { claim, release, record } — for example createPostgresEventLog
 * @param {Function} [options.onEvent] (event, tools) called for every parcel status change
 * @param {Function} [options.onPickedUp] (event, tools) first scan
 * @param {Function} [options.onDelivered] (event, tools)
 * @param {Function} [options.onIncident] (event, tools)
 * @param {string} [options.signatureHeader] default 'sendcloud-signature'
 * @param {object} [options.logger]
 * @param {number|false} [options.pruneOlderThanMs] when the event log has prune(): handled events older
 *   than this are deleted, at most once per `pruneEveryMs`, after a webhook is answered. Default 90 days;
 *   false disables it (prune it yourself).
 * @param {number} [options.pruneEveryMs] default 24 h
 * @param {Function} [options.now] for tests
 */
function createCarrierWebhook(options = {}) {
  const carrier = options.carrier;
  if (!carrier || typeof carrier.verifySignature !== 'function' || typeof carrier.readEvent !== 'function') {
    throw new TypeError('createCarrierWebhook needs a carrier with verifySignature() and readEvent().');
  }
  const header = String(options.signatureHeader || SIGNATURE_HEADER).toLowerCase();
  const byStage = { picked_up: options.onPickedUp, delivered: options.onDelivered, incident: options.onIncident };
  const eventLog = options.eventLog;
  const pruneOlderThanMs = options.pruneOlderThanMs === undefined ? DEFAULT_PRUNE_OLDER_THAN_MS : options.pruneOlderThanMs;
  const pruneEveryMs = options.pruneEveryMs || DEFAULT_PRUNE_EVERY_MS;
  const now = options.now || Date.now;
  const logger = options.logger || {};
  let lastPrune = null;
  let pruning = null;

  /* The event log only grows: old handled events are deleted now and then, never on the answer's path. */
  function maybePrune() {
    if (!pruneOlderThanMs || !eventLog || typeof eventLog.prune !== 'function' || pruning) return null;
    if (lastPrune !== null && now() - lastPrune < pruneEveryMs) return null;
    lastPrune = now();
    pruning = Promise.resolve()
      .then(() => eventLog.prune(pruneOlderThanMs))
      .catch((error) => { if (logger.warn) logger.warn(`[shipping] event log prune failed: ${error.message}`); })
      .finally(() => { pruning = null; });
    return pruning;
  }

  const handler = createWebhookHandler({
    eventLog,
    logger: options.logger,
    eventId: (event) => event.id,
    async verify({ payload, headers }) {
      if (!Buffer.isBuffer(payload)) {
        throw new Error('the body is not raw bytes: mount the webhook before any JSON body parser');
      }
      const signature = headers[header] ?? headers[header.toLowerCase()];
      if (!(await carrier.verifySignature(payload, Array.isArray(signature) ? signature[0] : signature))) {
        throw new Error('invalid signature');
      }
      let json;
      try {
        json = JSON.parse(payload.toString('utf8'));
      } catch {
        throw new Error('unreadable body');
      }
      const parcel = carrier.readEvent(json);
      return {
        id: createHash('sha256').update(payload).digest('hex'),
        type: parcel ? 'parcel_status_changed' : String(json && json.action || 'unknown'),
        parcel
      };
    },
    events: {
      async parcel_status_changed(event, tools) {
        if (typeof options.onEvent === 'function') await options.onEvent(event.parcel, tools);
        const act = byStage[event.parcel.stage];
        if (typeof act === 'function') {
          const outcome = await act(event.parcel, tools);
          if (outcome) return outcome;
        }
        return tools.handled(event.parcel.stage || 'status');
      }
    }
  });
  async function receive(request) {
    const answer = await handler.receive(request);
    maybePrune();
    return answer;
  }
  function middleware(req, res) {
    return receive({ payload: req.body, headers: req.headers }).then(({ status, body }) => {
      res.status(status).json(body);
    });
  }
  /** Waits for a prune in progress (tests, graceful shutdown). */
  const settled = () => pruning || Promise.resolve();
  return { receive, middleware, sideEffect: handler.sideEffect, settled };
}

module.exports = { createCarrierWebhook, SIGNATURE_HEADER };
