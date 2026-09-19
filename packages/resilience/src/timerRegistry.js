/**
 * A registry for background timers, with one switch to stop them all.
 *
 * Three defects this exists for, each seen in a real codebase:
 *
 *   - A timer set when a module LOADS, with no reference kept, can never be
 *     stopped. Requiring one cache module was enough to keep Node from ever
 *     exiting, and graceful shutdown waited on it for nothing.
 *
 *   - `unref()` is not a stop. It says "do not keep the process alive for me";
 *     it does NOT say "do not fire". An unref'd timer still fires on schedule —
 *     and when it fires after a Jest environment is torn down, it runs its code
 *     in a destroyed world and the worker has to be killed. Only clearing it
 *     prevents the fire. This registry does both: unref on track, clear on stop.
 *
 *   - Clearing a timer does not stop work that ALREADY STARTED. A tick woken
 *     one second before shutdown carries on down its promise chain into a
 *     closed database. `isStopped()` gives that work a way to give up before
 *     its next side effect.
 *
 * And one more: a `start()` called twice (hot reload, a retried boot) sets two
 * intervals, and the job runs twice as often forever. Tracking with a `key`
 * replaces the previous timer under that key instead of adding a second one.
 */

function defaultTimers() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    /* Node (and browsers) share one id space between the two families, but an
       injected implementation may not — so both are kept. */
    clearInterval: (timer) => clearInterval(timer),
    clearTimeout: (timer) => clearTimeout(timer)
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.timers] { setInterval, setTimeout, clearInterval, clearTimeout }
 */
function createTimerRegistry(options = {}) {
  const timers = { ...defaultTimers(), ...(options.timers || {}) };
  /** timer -> { kind, key } */
  const entries = new Map();
  /** key -> timer */
  const byKey = new Map();
  let stopped = false;

  function clear(timer, kind) {
    if (kind === 'timeout') timers.clearTimeout(timer);
    else timers.clearInterval(timer);
  }

  function forget(timer) {
    const entry = entries.get(timer);
    if (!entry) return false;
    entries.delete(timer);
    if (entry.key !== undefined && byKey.get(entry.key) === timer) byKey.delete(entry.key);
    return true;
  }

  /**
   * Register a timer and return it, so it reads as one line:
   *   registry.track(setInterval(cleanup, 60_000), { key: 'cleanup' })
   *
   * Tracking REOPENS the registry: a service restarting its timers cancels the
   * previous shutdown. Otherwise a hot reload leaves timers that fire while
   * their work silently gives up on `isStopped()` — the worst of both.
   */
  function track(timer, trackOptions = {}) {
    if (timer === undefined || timer === null) return timer;
    const kind = trackOptions.kind === 'timeout' ? 'timeout' : 'interval';
    const key = trackOptions.key;
    stopped = false;
    if (timer && typeof timer.unref === 'function') timer.unref();

    if (key !== undefined) {
      const previous = byKey.get(key);
      if (previous !== undefined && previous !== timer) {
        const previousEntry = entries.get(previous);
        clear(previous, previousEntry ? previousEntry.kind : kind);
        forget(previous);
      }
      byKey.set(key, timer);
    }
    entries.set(timer, { kind, key });
    return timer;
  }

  /** setInterval, tracked. */
  function every(ms, fn, trackOptions = {}) {
    return track(timers.setInterval(fn, ms), { ...trackOptions, kind: 'interval' });
  }

  /**
   * setTimeout, tracked — and forgotten once it has fired, so a registry fed
   * one-shot timers does not grow for the life of the process.
   */
  function after(ms, fn, trackOptions = {}) {
    const timer = timers.setTimeout(() => {
      forget(timer);
      fn();
    }, ms);
    return track(timer, { ...trackOptions, kind: 'timeout' });
  }

  /** Clear and forget one timer. Returns whether it was tracked. */
  function cancel(timer) {
    const entry = entries.get(timer);
    if (!entry) return false;
    clear(timer, entry.kind);
    return forget(timer);
  }

  /**
   * Stop EVERYTHING. Safe to call at any time, repeatedly, with nothing
   * running — it runs at server shutdown AND after every test file. One timer
   * whose clear throws must not leave the rest running.
   */
  function stopAll() {
    stopped = true;
    for (const [timer, entry] of entries) {
      try { clear(timer, entry.kind); } catch (_error) { /* keep stopping the others */ }
    }
    entries.clear();
    byKey.clear();
  }

  return {
    track,
    every,
    after,
    cancel,
    forget,
    stopAll,
    /** Check before any side effect in periodic work: has the app shut down? */
    isStopped: () => stopped,
    size: () => entries.size
  };
}

module.exports = { createTimerRegistry };
