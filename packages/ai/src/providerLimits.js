'use strict';

function readRetryAfter(response, now = Date.now()) {
  const value = response?.headers?.get?.('retry-after');
  if (value == null || !String(value).trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

// A bounded local inference queue: do not load a CPU server with an unlimited
// number of simultaneous calls. A slot is released on every outcome/abort.
function createInferenceQueue({ maxConcurrent = 8, maxQueue = 20 } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isInteger(maxQueue) || maxQueue < 0) throw new TypeError('INVALID_INFERENCE_QUEUE');
  const waiting = [];
  let active = 0;
  const error = (code) => Object.assign(new Error(code), { code });
  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active < maxConcurrent) { active += 1; return Promise.resolve(); }
    if (waiting.length >= maxQueue) return Promise.reject(error('AI_LOCAL_QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => { const at = waiting.indexOf(waiter); if (at >= 0) waiting.splice(at, 1); reject(signal.reason); };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      waiting.push(waiter);
    });
  }
  function release() {
    const waiter = waiting.shift();
    if (!waiter) { active -= 1; return; }
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  }
  return {
    async run(task, { signal } = {}) {
      await acquire(signal);
      try { signal?.throwIfAborted(); return await task(); }
      finally { release(); }
    },
    stats: () => ({ active, waiting: waiting.length })
  };
}
module.exports = { readRetryAfter, createInferenceQueue };
