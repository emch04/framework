/**
 * Remembering which events have already been acted on.
 *
 * Providers resend events, by design and on purpose: they cannot tell a lost
 * response from a slow one, so they err on the side of sending again. Without a
 * record, the second delivery re-confirms an order, re-sends a receipt, or
 * re-credits an account.
 *
 * Two methods, so any store fits — a table, a Redis key, a collection:
 *
 *   seen(eventId)   -> boolean
 *   record(eventId, meta) -> void
 */

/**
 * In-process log for tests and local development. Not persistent, and NOT safe
 * across several instances: two processes each keep their own memory, so a
 * replay reaching the other one goes through. Use a shared store in production.
 */
function createMemoryEventLog(options = {}) {
  const limit = options.limit || 10_000;
  const seen = new Map();

  return {
    async seen(eventId) {
      return seen.has(String(eventId));
    },
    async record(eventId, meta = {}) {
      seen.set(String(eventId), { at: new Date(), ...meta });
      /* A log that only grows is a memory leak with a long fuse. Oldest out
         first — a replay older than the last ten thousand events is not a
         scenario worth holding memory for. */
      if (seen.size > limit) {
        const oldest = seen.keys().next().value;
        seen.delete(oldest);
      }
    },
    size: () => seen.size
  };
}

module.exports = { createMemoryEventLog };
