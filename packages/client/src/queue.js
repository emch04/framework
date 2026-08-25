/**
 * Work that survives losing the network.
 *
 * An app used in the field — a classroom with no signal, a shop with flaky
 * wifi — cannot treat "offline" as an error. A mutation made offline is
 * RECORDED instead of failed: it joins a queue, and when the network returns
 * the queue replays, in order.
 *
 * The rules that make a queue trustworthy:
 *
 *   ORDER IS KEPT. "Mark present" then "mark absent" must land in that order,
 *   or the record ends up saying the opposite of what the person did.
 *
 *   A FAILURE STOPS THE REPLAY, it does not skip. Skipping a failed action and
 *   applying the ones behind it replays history out of order — the very thing
 *   the queue exists to prevent. The queue halts, reports, and retries from
 *   the same place next time.
 *
 *   EXCEPT WHEN THE SERVER SAYS NO. A rejection (a 4xx) is an answer: the
 *   action is wrong, and holding the whole queue hostage behind it strands
 *   every action after it forever. Rejected actions are set aside — visibly.
 *
 * Storage is injected: IndexedDB on the web, SQLite or AsyncStorage on
 * mobile, memory in tests. Same logic.
 */

const NOOP_LOGGER = { warn() {}, error() {} };

/** In-process store for tests. Not persistent — which defeats the purpose
    outside them. */
function createMemoryQueueStore() {
  let sequence = 0;
  const rows = new Map();
  const clone = (r) => JSON.parse(JSON.stringify(r));

  return {
    async append(action) {
      const id = ++sequence;
      rows.set(id, { id, ...action });
      return clone(rows.get(id));
    },
    async list() {
      return [...rows.values()].sort((a, b) => a.id - b.id).map(clone);
    },
    async remove(id) { rows.delete(id); },
    size: () => rows.size
  };
}

/**
 * @param {object} options
 * @param {object} options.store  { append, list, remove } — list() oldest first.
 * @param {Record<string, Function>} options.handlers  action type -> async (payload) => void.
 *   The handler performs the real call. It must THROW on failure, and the
 *   error's `status` tells a rejection (4xx) from an outage (anything else).
 * @param {Function} [options.isRejection] (error) => boolean. Default: 400–499.
 * @param {Function} [options.onRejected]  (action, error) => void — the user
 *   must LEARN that something they did offline was refused. Silence here means
 *   work they believe is saved, is not.
 * @param {object} [options.logger]
 */
function createOfflineQueue(options = {}) {
  const store = options.store;
  for (const method of ['append', 'list', 'remove']) {
    if (!store || typeof store[method] !== 'function') {
      throw new Error(`createOfflineQueue requires options.store.${method}().`);
    }
  }

  const handlers = options.handlers || {};
  if (!Object.keys(handlers).length) {
    throw new Error('createOfflineQueue requires at least one handler.');
  }

  const isRejection = options.isRejection
    || ((error) => typeof (error && error.status) === 'number' && error.status >= 400 && error.status < 500);
  const onRejected = options.onRejected || null;
  const logger = options.logger || NOOP_LOGGER;

  /* One replay at a time. Two concurrent replays — a sync event and a
     manual retry — would apply the same actions twice. */
  let replaying = null;

  /** Record an action for later. */
  async function enqueue(type, payload) {
    if (!handlers[type]) {
      /* An action nobody can replay would sit in the queue forever. Refuse it
         now, while the caller can still see the mistake. */
      throw new Error(`"${type}" has no handler — it could never be replayed.`);
    }
    return store.append({ type, payload, queuedAt: new Date().toISOString() });
  }

  async function runReplay() {
    const report = { applied: 0, rejected: 0, halted: false, remaining: 0, error: null };
    const actions = await store.list();

    for (const action of actions) {
      const handler = handlers[action.type];
      if (!handler) {
        /* Queued under an old version of the app. Set aside as rejected:
           it will never become replayable by waiting. */
        report.rejected += 1;
        await store.remove(action.id);
        if (onRejected) onRejected(action, new Error(`no handler for "${action.type}"`));
        continue;
      }

      try {
        await handler(action.payload, action);
        await store.remove(action.id);
        report.applied += 1;
      } catch (error) {
        if (isRejection(error)) {
          /* The server answered: this action is wrong. Holding the queue
             hostage behind it would strand everything after it, forever. */
          logger.warn(`[offline] "${action.type}" rejected: ${error.message}`);
          await store.remove(action.id);
          report.rejected += 1;
          if (onRejected) onRejected(action, error);
          continue;
        }
        /* An outage. STOP — replaying the actions behind this one would apply
           history out of order. Same place next time. */
        report.halted = true;
        report.error = error.message;
        break;
      }
    }

    report.remaining = (await store.list()).length;
    return report;
  }

  /** Replay the queue. Concurrent calls share one run. */
  function replay() {
    if (!replaying) {
      replaying = runReplay().finally(() => { replaying = null; });
    }
    return replaying;
  }

  /** What waits — for a badge in the interface. */
  async function pending() {
    return store.list();
  }

  return { enqueue, replay, pending };
}

module.exports = { createOfflineQueue, createMemoryQueueStore };
