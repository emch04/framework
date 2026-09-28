/**
 * How often one account may ask the AI: a sliding window per person, in
 * memory — one process. For several instances, put the counter in Redis (the
 * provider router already does for provider quotas).
 *
 * Each area (chat, image, voice) keeps its own limiter with its own code. The
 * refusal carries a code and the wait, never a sentence: the client translates.
 *
 * Accounts that stop asking are forgotten: a map that only grows is a slow
 * memory leak on a server that runs for months.
 */
const { AppError } = require('@astratra/core');

/**
 * @param {object} options
 * @param {number} options.max       asks allowed in the window.
 * @param {number} options.windowMs
 * @param {string} [options.code]    Default 'AI_RATE_LIMITED'.
 * @param {number} [options.sweepEvery] asks between two clean-ups. Default 500.
 */
function createAskLimit(options = {}) {
  const { max, windowMs } = options;
  if (!Number.isInteger(max) || max < 1) throw new Error('createAskLimit requires an integer options.max >= 1.');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('createAskLimit requires options.windowMs > 0.');
  const code = options.code || 'AI_RATE_LIMITED';
  const sweepEvery = options.sweepEvery || 500;
  const asks = new Map();
  let sinceSweep = 0;

  function sweep(now) {
    for (const [id, times] of asks) {
      const recent = times.filter((at) => now - at < windowMs);
      if (recent.length) asks.set(id, recent);
      else asks.delete(id);
    }
  }

  /** What `take` would answer, without counting an ask. */
  function peek(subject, now = Date.now()) {
    const recent = (asks.get(String(subject)) || []).filter((at) => now - at < windowMs);
    if (recent.length < max) return { allowed: true, remaining: max - recent.length, retryInMs: 0 };
    return { allowed: false, remaining: 0, retryInMs: Math.max(0, recent[0] + windowMs - now) };
  }

  /** Count one ask; throws a 429 AppError carrying `code` and `retryInMs` past the limit. */
  function take(subject, now = Date.now()) {
    const id = String(subject);
    sinceSweep += 1;
    if (sinceSweep >= sweepEvery) {
      sinceSweep = 0;
      sweep(now);
    }
    const verdict = peek(id, now);
    if (!verdict.allowed) {
      const error = new AppError(code, 429);
      error.code = code;
      error.retryInMs = verdict.retryInMs;
      throw error;
    }
    const recent = (asks.get(id) || []).filter((at) => now - at < windowMs);
    recent.push(now);
    asks.set(id, recent);
    return { allowed: true, remaining: max - recent.length, retryInMs: 0 };
  }

  return { take, peek, reset: (subject) => (subject === undefined ? asks.clear() : asks.delete(String(subject))), size: () => asks.size, sweep };
}

module.exports = { createAskLimit };
