/**
 * An audit log that shows when it has been edited.
 *
 * A plain log is a list of claims. Anyone with database access can change a
 * line or delete one, and nothing about the result looks wrong — which is
 * precisely the moment you most need the log to be trustworthy.
 *
 * Chaining fixes that. Each entry carries the hash of the one before it, so
 * every entry depends on the entire history behind it. Change one field and its
 * hash no longer matches; delete an entry and the next one points at something
 * that is not there. Neither can be hidden without rewriting everything after
 * it — and if the log is also copied off-machine, not even then.
 *
 * This makes tampering EVIDENT, not impossible. That is the honest claim, and
 * it is the one worth making.
 */
const crypto = require('crypto');
const { stableStringify } = require('./stableStringify');

/** The link the first entry points at: there is nothing before it. */
const GENESIS_HASH = '0'.repeat(64);

const FIELDS = ['type', 'actor', 'target', 'level', 'message', 'meta', 'context', 'previousHash', 'recordedAt'];

/** Only the signed fields, in a fixed shape — extra columns must not shift it. */
function canonical(event) {
  const payload = {};
  for (const field of FIELDS) {
    if (event[field] !== undefined) payload[field] = event[field];
  }
  return payload;
}

function hashEvent(event) {
  return crypto.createHash('sha256').update(stableStringify(canonical(event))).digest('hex');
}

/**
 * @param {object} options
 * @param {object} options.store  { last(), append(event) } and, to verify,
 *   { list() } returning entries oldest first.
 * @param {Function} [options.now]
 * @param {object} [options.logger]
 * @param {Function} [options.onRecordFailed] (error, event) => void.
 */
function createAuditChain(options = {}) {
  const store = options.store;
  for (const method of ['last', 'append']) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`createAuditChain requires options.store.${method}().`);
    }
  }

  const now = options.now || (() => new Date());
  const logger = options.logger || { error() {} };
  const onRecordFailed = options.onRecordFailed || null;

  /**
   * Append an entry.
   *
   * Never throws. An audit write that fails must not take down the operation
   * it was recording — losing the trace is bad, losing the payment is worse.
   * The failure is reported instead, loudly.
   */
  async function record(event = {}) {
    try {
      const previous = await store.last();
      const previousHash = (previous && previous.hash) || GENESIS_HASH;

      const entry = {
        ...event,
        previousHash,
        recordedAt: (event.recordedAt || now()).toISOString
          ? (event.recordedAt || now()).toISOString()
          : String(event.recordedAt || now())
      };
      entry.hash = hashEvent(entry);

      return await store.append(entry);
    } catch (error) {
      logger.error(`[audit] could not record "${event.type || 'event'}": ${error.message}`);
      if (onRecordFailed) onRecordFailed(error, event);
      return null;
    }
  }

  /**
   * Walk the chain and say where, if anywhere, it stops adding up.
   *
   * Two failures, and telling them apart matters:
   *
   *   altered  — the entry's own hash does not match its content;
   *   broken   — the entry does not point at the one before it, so something
   *              was deleted or inserted.
   *
   * @param {Array} [events] oldest first. Read from the store when omitted.
   * @returns {Promise<{intact: boolean, checked: number, failure?: object}>}
   */
  async function verify(events) {
    const entries = events || (typeof store.list === 'function' ? await store.list() : null);
    if (!entries) {
      throw new Error('createAuditChain.verify needs events, or options.store.list().');
    }

    let expectedPrevious = GENESIS_HASH;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];

      if (entry.previousHash !== expectedPrevious) {
        return {
          intact: false,
          checked: index,
          failure: {
            reason: 'broken', index, entry,
            detail: 'this entry does not follow the previous one — an entry was removed or inserted'
          }
        };
      }

      if (entry.hash !== hashEvent(entry)) {
        return {
          intact: false,
          checked: index,
          failure: {
            reason: 'altered', index, entry,
            detail: 'this entry\'s content no longer matches its own hash'
          }
        };
      }

      expectedPrevious = entry.hash;
    }

    return { intact: true, checked: entries.length };
  }

  return { record, verify, hashEvent, GENESIS_HASH };
}

/** In-process chain for tests and development. Not persistent. */
function createMemoryAuditStore() {
  const entries = [];
  return {
    async last() { return entries[entries.length - 1] || null; },
    async append(entry) { entries.push(entry); return entry; },
    async list() { return [...entries]; },
    entries
  };
}

module.exports = { createAuditChain, createMemoryAuditStore, hashEvent, GENESIS_HASH };
