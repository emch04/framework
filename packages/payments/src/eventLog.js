/**
 * Remembering which events have already been acted on.
 *
 * Providers resend events, by design and on purpose: they cannot tell a lost
 * response from a slow one, so they err on the side of sending again. Without a
 * record, the second delivery re-confirms an order, re-sends a receipt, or
 * re-credits an account.
 *
 * And they resend CONCURRENTLY: a retry can land while the first delivery is
 * still running. "Have I seen it?" then "remember it" leaves a window where both
 * deliveries answer no. The event must be reserved atomically BEFORE it is
 * handled:
 *
 *   claim(eventId, meta)  -> boolean  true: reserved now, handle it.
 *                                     false: already handled or being handled.
 *   release(eventId)      -> void     the handler failed: free the claim so the
 *                                     provider's retry can work.
 *   record(eventId, meta) -> void     handled: the claim becomes permanent.
 *   seen(eventId)         -> boolean  handled (a claim in progress is not).
 *
 * In SQL, claim is one statement on a unique key:
 *   INSERT INTO webhook_events (id, status, claimed_at) VALUES ($1, 'pending', now())
 *   ON CONFLICT (id) DO UPDATE SET claimed_at = now()
 *     WHERE webhook_events.status = 'pending' AND webhook_events.claimed_at < now() - interval '15 minutes'
 *   RETURNING id;   -- a row back means claimed
 * A claim must expire: a process that crashes mid-handler never releases it.
 */

const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * In-process log for tests and local development. Not persistent, and NOT safe
 * across several instances: two processes each keep their own memory, so a
 * replay reaching the other one goes through. Use a shared store in production.
 */
function createMemoryEventLog(options = {}) {
  const limit = options.limit || 10_000;
  const claimTtlMs = options.claimTtlMs || DEFAULT_CLAIM_TTL_MS;
  const now = options.now || Date.now;
  const entries = new Map();

  function trim() {
    /* A log that only grows is a memory leak with a long fuse. Oldest out
       first — a replay older than the last ten thousand events is not a
       scenario worth holding memory for. */
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  return {
    /* Synchronous between the read and the write: within one process, no
       other delivery can slip in between. */
    async claim(eventId, meta = {}) {
      const key = String(eventId);
      const entry = entries.get(key);
      if (entry && (entry.handled || now() - entry.claimedAt < claimTtlMs)) return false;
      entries.delete(key);
      entries.set(key, { handled: false, claimedAt: now(), ...meta });
      trim();
      return true;
    },
    async release(eventId) {
      const key = String(eventId);
      const entry = entries.get(key);
      if (entry && !entry.handled) entries.delete(key);
    },
    async seen(eventId) {
      const entry = entries.get(String(eventId));
      return Boolean(entry && entry.handled);
    },
    async record(eventId, meta = {}) {
      const key = String(eventId);
      const previous = entries.get(key) || {};
      entries.set(key, { ...previous, ...meta, handled: true, at: new Date(now()) });
      trim();
    },
    size: () => entries.size
  };
}

module.exports = { createMemoryEventLog };
