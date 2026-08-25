/**
 * Sending mail, with the parts that are always the same.
 *
 * The transport is yours — SMTP, an HTTP API, whatever your provider offers.
 * What this adds is the ring around it, and it is the same ring every time:
 *
 *   nothing user-supplied reaches a header unsanitised;
 *   a send that fails does NOT fail the request that triggered it;
 *   several senders coexist without their credentials getting mixed up.
 *
 * That second point deserves saying plainly. A confirmation email is a
 * consequence of an action, not the action itself. When the order is placed and
 * the money taken, an SMTP timeout must not turn into a 500 that tells the
 * customer their order failed. So nothing here throws: every call returns a
 * result you can look at, log, or ignore.
 */
const { sanitizeHeader, sanitizeAddress, formatSender } = require('./headers');

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

const listOf = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/**
 * @param {object} options
 * @param {Record<string, object>} options.channels  named senders. Each one:
 *   { send: async (message) => any, from, fromName?, replyTo? }
 *   Several channels because a receipt and a security alert should not travel
 *   on the same reputation, nor share credentials.
 * @param {string} [options.defaultChannel] defaults to the first declared.
 * @param {object} [options.logger]
 * @param {number} [options.subjectMaxLength]
 */
function createMailer(options = {}) {
  const channels = options.channels || {};
  const names = Object.keys(channels);
  if (!names.length) {
    throw new Error('createMailer requires at least one channel.');
  }

  for (const [name, channel] of Object.entries(channels)) {
    if (!channel || typeof channel.send !== 'function') {
      throw new Error(`createMailer: channel "${name}" needs a send() function.`);
    }
  }

  const defaultChannel = options.defaultChannel || names[0];
  if (!channels[defaultChannel]) {
    throw new Error(`createMailer: defaultChannel "${defaultChannel}" is not a declared channel.`);
  }

  const logger = options.logger || NOOP_LOGGER;
  const subjectMaxLength = options.subjectMaxLength || 200;

  /**
   * @param {object} message { to, subject, text?, html?, channel?, from?,
   *   fromName?, replyTo?, cc?, bcc?, attachments? }
   * @returns {Promise<{sent: boolean, channel: string, to: string[], reason?: string, error?: string, result?: any}>}
   *   Never throws.
   */
  async function send(message = {}) {
    const channelName = message.channel || defaultChannel;
    const channel = channels[channelName];

    if (!channel) {
      logger.error(`[mailer] unknown channel "${channelName}" — nothing sent`);
      return { sent: false, channel: channelName, to: [], reason: 'unknown-channel' };
    }

    /* A malformed recipient is dropped rather than passed on: providers reject
       the whole message for one bad address, so one typo in a list would lose
       every other recipient too. */
    const recipients = listOf(message.to).map(sanitizeAddress).filter(Boolean);
    if (!recipients.length) {
      logger.warn('[mailer] no valid recipient — nothing sent');
      return { sent: false, channel: channelName, to: [], reason: 'no-recipient' };
    }

    const subject = sanitizeHeader(message.subject, { maxLength: subjectMaxLength });
    if (!subject) {
      logger.warn('[mailer] no subject — nothing sent');
      return { sent: false, channel: channelName, to: recipients, reason: 'no-subject' };
    }

    if (!message.text && !message.html) {
      logger.warn(`[mailer] "${subject}" has no body — nothing sent`);
      return { sent: false, channel: channelName, to: recipients, reason: 'no-body' };
    }

    const from = formatSender(
      message.from || channel.from,
      message.fromName === undefined ? channel.fromName : message.fromName
    );
    if (!from) {
      /* Not configured is not a crash. A product with no mail credentials in
         development should log and carry on, not fall over on every signup. */
      logger.warn(`[mailer] channel "${channelName}" has no valid sender address — nothing sent`);
      return { sent: false, channel: channelName, to: recipients, reason: 'no-sender' };
    }

    const replyTo = sanitizeAddress(message.replyTo || channel.replyTo);

    const payload = {
      from,
      to: recipients,
      subject,
      text: message.text,
      html: message.html,
      cc: listOf(message.cc).map(sanitizeAddress).filter(Boolean),
      bcc: listOf(message.bcc).map(sanitizeAddress).filter(Boolean),
      attachments: message.attachments
    };
    if (replyTo) payload.replyTo = replyTo;

    try {
      const result = await channel.send(payload);
      logger.info(`[mailer] "${subject}" sent to ${recipients.length} recipient(s) via ${channelName}`);
      return { sent: true, channel: channelName, to: recipients, result };
    } catch (error) {
      /* The caller decides what a failure means. Most of the time: log it and
         move on, because the thing the mail was about already happened. */
      logger.error(`[mailer] "${subject}" failed via ${channelName}: ${error.message}`);
      return { sent: false, channel: channelName, to: recipients, reason: 'send-failed', error: error.message };
    }
  }

  return { send, channels: names, defaultChannel };
}

/**
 * A channel that records instead of sending.
 *
 * For tests, and for a development environment where a real send would reach a
 * real person. Reading `sent` is how you assert on mail without a mail server.
 */
function createCaptureChannel(config = {}) {
  const sent = [];
  return {
    from: config.from || 'capture@example.invalid',
    fromName: config.fromName,
    replyTo: config.replyTo,
    send: async (message) => { sent.push(message); return { captured: true }; },
    sent,
    last: () => sent[sent.length - 1] || null,
    clear: () => { sent.length = 0; }
  };
}

module.exports = { createMailer, createCaptureChannel };
