/**
 * Sending SMS, whatever carries them.
 *
 * The transport is injected — Twilio, Infobip, a local gateway. What this adds
 * is the same ring as mail: nothing user-facing throws, and the absence of a
 * configured provider is a VISIBLE simulation, not a crash. A product in
 * development sends its codes to the log, loudly labelled, instead of falling
 * over on every verification — and instead of silently pretending it sent.
 */

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * A number good enough to hand a provider: digits and one leading plus.
 *
 * Not a validation — phone plans vary too much for a regex to rule on. What
 * it strips is what breaks providers: spaces, dots, dashes, parentheses.
 */
function normalizePhone(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  const cleaned = (raw.startsWith('+') ? '+' : '') + raw.replace(/\D/g, '');
  return cleaned.length >= 8 ? cleaned : null;
}

/**
 * @param {object} options
 * @param {Function} [options.transport] async ({ to, text }) => any. Absent
 *   means SIMULATION: logged, labelled, returned as such.
 * @param {number} [options.maxLength] hard cap. Default 480 (3 segments) —
 *   an unbounded text concatenated into an SMS is how a bug becomes a bill.
 * @param {object} [options.logger]
 */
function createSmsSender(options = {}) {
  const transport = options.transport || null;
  const maxLength = options.maxLength || 480;
  const logger = options.logger || NOOP_LOGGER;

  /**
   * @returns {Promise<{sent: boolean, simulated?: boolean, to?: string, reason?: string, error?: string}>}
   *   Never throws.
   */
  async function send(to, text) {
    const phone = normalizePhone(to);
    if (!phone) {
      logger.warn('[sms] no valid number — nothing sent');
      return { sent: false, reason: 'no-recipient' };
    }

    const body = String(text === null || text === undefined ? '' : text).trim();
    if (!body) {
      logger.warn('[sms] empty message — nothing sent');
      return { sent: false, to: phone, reason: 'no-text' };
    }
    const capped = body.length > maxLength ? `${body.slice(0, maxLength - 1)}…` : body;

    if (!transport) {
      /* Loud on purpose: a simulated send that looks real is worse than a
         failure — someone waits for a code that never left the log. */
      logger.warn(`[sms] SIMULATION — no transport configured. To ${phone}: ${capped}`);
      return { sent: true, simulated: true, to: phone };
    }

    try {
      const result = await transport({ to: phone, text: capped });
      logger.info(`[sms] sent to ${phone}`);
      return { sent: true, to: phone, result };
    } catch (error) {
      logger.error(`[sms] failed to ${phone}: ${error.message}`);
      return { sent: false, to: phone, reason: 'send-failed', error: error.message };
    }
  }

  return { send, normalizePhone };
}

module.exports = { createSmsSender, normalizePhone };
