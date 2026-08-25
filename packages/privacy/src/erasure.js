/**
 * Erasure goes through a human. Always.
 *
 * A one-click irreversible delete is a gift to anyone who borrows a session for
 * thirty seconds, and to any user having a bad day. It is also, in most
 * products, a decision someone else has a say in: the school still owes the
 * records, the company still owes the invoices.
 *
 * So a request is made, a person reviews it, and only an approval executes it.
 * Every step is recorded — who asked, who decided, when, and why.
 */
const { assertStore } = require('./utils');

const PENDING = 'pending';
const APPROVED = 'approved';
const REJECTED = 'rejected';
const COMPLETED = 'completed';
const FAILED = 'failed';

class ErasureError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ErasureError';
    this.statusCode = statusCode;
  }
}

/**
 * @param {object} options
 * @param {object} options.store  { create, find, update, list }.
 * @param {Function} options.erase async (request) => any. What actually
 *   anonymises — typically wraps createAnonymizer() plus your save.
 * @param {Function} [options.now]
 * @param {object} [options.logger]
 */
function createErasureWorkflow(options = {}) {
  const store = options.store;
  assertStore(store, ['create', 'find', 'update'], 'options.store');

  const erase = options.erase;
  if (typeof erase !== 'function') {
    throw new Error('createErasureWorkflow requires options.erase.');
  }

  const now = options.now || (() => new Date());
  const logger = options.logger || { info() {}, error() {} };

  /** Someone asks for their data to be erased. Nothing happens yet. */
  async function request({ subject, reason, requestedBy } = {}) {
    if (subject === undefined || subject === null) {
      throw new ErasureError('An erasure request needs a subject.');
    }
    const record = await store.create({
      subject,
      reason: reason || null,
      requestedBy: requestedBy === undefined ? subject : requestedBy,
      status: PENDING,
      requestedAt: now()
    });
    logger.info(`[privacy] erasure requested for ${subject}`);
    return record;
  }

  async function load(id) {
    const record = await store.find(id);
    if (!record) throw new ErasureError('This erasure request could not be found.', 404);
    return record;
  }

  function assertPending(record) {
    if (record.status === PENDING) return;
    /* Approving twice would run an irreversible operation a second time on a
       record that no longer holds what it held. */
    throw new ErasureError(`This request has already been ${record.status}.`, 409);
  }

  /**
   * A human approves — and the erasure runs.
   *
   * If the erasure itself fails, the request is marked failed rather than
   * completed. Recording a success that did not happen is how a product tells
   * a regulator it erased data it still holds.
   */
  async function approve(id, { reviewedBy, note } = {}) {
    const record = await load(id);
    assertPending(record);

    if (reviewedBy === undefined || reviewedBy === null) {
      throw new ErasureError('An approval must record who approved it.');
    }
    /* The point of the gate is a SECOND pair of eyes. Approving your own
       request restores the one-click delete this exists to prevent. */
    if (String(reviewedBy) === String(record.requestedBy)) {
      throw new ErasureError('An erasure request cannot be approved by the person who made it.', 403);
    }

    const decided = { reviewedBy, reviewedAt: now(), reviewNote: note || null };

    try {
      const result = await erase(record);
      const done = await store.update(id, { ...decided, status: COMPLETED, completedAt: now() });
      logger.info(`[privacy] erasure completed for ${record.subject} (approved by ${reviewedBy})`);
      return { request: done, result };
    } catch (error) {
      await store.update(id, { ...decided, status: FAILED, failedAt: now(), failureReason: error.message });
      logger.error(`[privacy] erasure FAILED for ${record.subject}: ${error.message}`);
      throw error;
    }
  }

  /** A human refuses, and says why. */
  async function reject(id, { reviewedBy, note } = {}) {
    const record = await load(id);
    assertPending(record);

    if (reviewedBy === undefined || reviewedBy === null) {
      throw new ErasureError('A rejection must record who rejected it.');
    }

    const done = await store.update(id, {
      status: REJECTED, reviewedBy, reviewedAt: now(), reviewNote: note || null
    });
    logger.info(`[privacy] erasure rejected for ${record.subject} (by ${reviewedBy})`);
    return done;
  }

  /** What is waiting for a human. */
  async function pending(filter = {}) {
    if (typeof store.list !== 'function') {
      throw new Error('createErasureWorkflow: options.store.list is required to list pending requests.');
    }
    return store.list({ ...filter, status: PENDING });
  }

  return { request, approve, reject, pending, load, PENDING, APPROVED, REJECTED, COMPLETED, FAILED };
}

module.exports = { createErasureWorkflow, ErasureError, PENDING, APPROVED, REJECTED, COMPLETED, FAILED };
