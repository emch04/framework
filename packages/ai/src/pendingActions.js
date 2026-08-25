/**
 * The airlock between an agent that proposes and a human who decides.
 *
 * An agent allowed to write is dangerous in a way an agent that answers is not.
 * The failure is not malice, it is confidence: the model calls send_email with
 * a plausible recipient and a plausible body, and a real family receives a real
 * message nobody approved.
 *
 * So a write is never executed on the model's say-so. It becomes a PENDING
 * ACTION: recorded, visible, waiting. A person approves it, and only then does
 * it run — through a lifecycle that also guarantees it cannot run twice.
 *
 *   proposed -> approved -> executing -> executed
 *                  \-> rejected            \-> failed
 *
 * The `executing` step is not decoration. The transition INTO it is atomic
 * (one findOneAndUpdate-style claim in the store): two people clicking
 * "approve" at the same moment produce one send, not two.
 */
const { AppError } = require('@astratra/core');

const PROPOSED = 'proposed';
const APPROVED = 'approved';
const REJECTED = 'rejected';
const EXECUTING = 'executing';
const EXECUTED = 'executed';
const FAILED = 'failed';

const OPEN_STATUSES = [PROPOSED, APPROVED, EXECUTING];

/**
 * @param {object} options
 * @param {object} options.store  adapter:
 *   create(data), find(id), claim(id, from[], patch)  — atomic status change,
 *   update(id, patch), findOpenByKey(dedupeKey), list(filter).
 * @param {Record<string, Function>} options.tools  action name -> executor.
 *   Only what is listed here can EVER run. An action recorded with a name this
 *   map does not carry is refused at execution, however it got approved.
 * @param {Function} [options.onPending] async (action) => void — tell the
 *   humans something waits. Failures are swallowed: the action stays visible
 *   in its list even if the notification channel is down.
 * @param {Function} [options.now]
 * @param {object} [options.logger]
 */
function createPendingActions(options = {}) {
  const store = options.store;
  for (const method of ['create', 'find', 'claim', 'update']) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`createPendingActions requires options.store.${method}().`);
    }
  }

  const tools = options.tools || {};
  if (!Object.keys(tools).length) {
    throw new Error('createPendingActions requires at least one tool in options.tools.');
  }

  const onPending = options.onPending || null;
  const now = options.now || (() => new Date());
  const logger = options.logger || { info() {}, warn() {}, error() {} };

  /**
   * The agent proposes a write. Nothing happens yet.
   *
   * `dedupeKey` is what stops an insistent model from stacking five identical
   * proposals: the same open action is returned instead of a new one.
   */
  async function propose({ action, payload = {}, description, proposedBy, tenant, dedupeKey } = {}) {
    if (!action || !tools[action]) {
      throw new AppError(`"${action}" is not a tool this airlock knows.`, 400);
    }

    if (dedupeKey && typeof store.findOpenByKey === 'function') {
      const existing = await store.findOpenByKey(dedupeKey, OPEN_STATUSES);
      if (existing) return { created: false, action: existing };
    }

    const record = await store.create({
      action, payload, description: description || null,
      proposedBy: proposedBy || null, tenant: tenant || null,
      dedupeKey: dedupeKey || null,
      status: PROPOSED, proposedAt: now()
    });

    if (onPending) {
      try {
        await onPending(record);
      } catch (error) {
        /* The action stays visible in its list either way. The agent must not
           fail because the notification backend blinked. */
        logger.warn(`[pending-actions] notification failed: ${error.message}`);
      }
    }

    return { created: true, action: record };
  }

  /**
   * A human says yes — and the action runs, once.
   */
  async function approve(id, { approvedBy, amend } = {}) {
    if (approvedBy === undefined || approvedBy === null) {
      throw new AppError('An approval must record who approved it.', 400);
    }

    const pending = await store.find(id);
    if (!pending) throw new AppError('This action could not be found.', 404);
    if (pending.status !== PROPOSED) {
      throw new AppError(`This action has already been ${pending.status}.`, 409);
    }

    const tool = tools[pending.action];
    if (!tool) {
      /* Recorded under one catalogue, approved under another — a deploy
         between the two, or a tampered record. Refuse. */
      throw new AppError(`Tool "${pending.action}" is not available any more.`, 400);
    }

    /* The atomic claim. Whoever loses this race gets a clean "already
       handled", not a second execution. */
    const claimed = await store.claim(id, [PROPOSED], {
      status: EXECUTING, approvedBy, approvedAt: now()
    });
    if (!claimed) return { executed: false, reason: 'already-handled' };

    /* An amendment comes from the HUMAN — correcting a recipient, trimming a
       list. The model's payload is never silently replaced; the two are
       merged with the human's values on top, and the amendment is recorded. */
    const payload = amend ? { ...claimed.payload, ...amend } : claimed.payload;

    try {
      const result = await tool(payload, { action: claimed, approvedBy });
      /* A tool that RETURNS an error has not succeeded, even though it did not
         throw. Marking it executed would show "sent" for a message that never
         left. */
      if (result && result.error) throw new AppError(String(result.error), 502);

      const done = await store.update(id, { status: EXECUTED, executedAt: now(), amendedWith: amend || null });
      logger.info(`[pending-actions] "${claimed.action}" executed (approved by ${approvedBy})`);
      return { executed: true, action: done, result };
    } catch (error) {
      await store.update(id, { status: FAILED, failedAt: now(), lastError: error.message });
      logger.error(`[pending-actions] "${claimed.action}" failed: ${error.message}`);
      return { executed: false, reason: 'failed', error: error.message };
    }
  }

  /** A human says no. The record stays — a refused proposal is information. */
  async function reject(id, { rejectedBy, note } = {}) {
    if (rejectedBy === undefined || rejectedBy === null) {
      throw new AppError('A rejection must record who rejected it.', 400);
    }
    const pending = await store.find(id);
    if (!pending) throw new AppError('This action could not be found.', 404);
    if (pending.status !== PROPOSED) {
      throw new AppError(`This action has already been ${pending.status}.`, 409);
    }
    return store.update(id, { status: REJECTED, rejectedBy, rejectedAt: now(), reviewNote: note || null });
  }

  /** What waits for a human. */
  async function pending(filter = {}) {
    if (typeof store.list !== 'function') {
      throw new Error('createPendingActions: options.store.list is required to list.');
    }
    return store.list({ ...filter, status: PROPOSED });
  }

  return {
    propose, approve, reject, pending,
    tools: Object.keys(tools),
    PROPOSED, APPROVED, REJECTED, EXECUTING, EXECUTED, FAILED, OPEN_STATUSES
  };
}

/** In-process store for tests and development. Not persistent. */
function createMemoryActionStore() {
  const records = new Map();
  let sequence = 0;
  const clone = (r) => (r ? JSON.parse(JSON.stringify(r)) : r);

  return {
    async create(data) {
      const id = String(++sequence);
      records.set(id, { id, ...data });
      return clone(records.get(id));
    },
    async find(id) { return clone(records.get(String(id))) || null; },
    async claim(id, fromStatuses, patch) {
      const record = records.get(String(id));
      if (!record || !fromStatuses.includes(record.status)) return null;
      Object.assign(record, patch);
      return clone(record);
    },
    async update(id, patch) {
      const record = records.get(String(id));
      if (!record) return null;
      Object.assign(record, patch);
      return clone(record);
    },
    async findOpenByKey(dedupeKey, statuses) {
      for (const record of records.values()) {
        if (record.dedupeKey === dedupeKey && statuses.includes(record.status)) return clone(record);
      }
      return null;
    },
    async list(filter = {}) {
      return [...records.values()]
        .filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
        .map(clone);
    },
    size: () => records.size
  };
}

module.exports = { createPendingActions, createMemoryActionStore };
