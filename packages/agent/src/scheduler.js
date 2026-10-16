'use strict';
// Timed task scheduler: wall-clock schedules in a time zone, one run at a time per task (injectable lock),
// missed runs skipped past a delay, global stop checked before and during a run, manual runs, readable state.
// Nothing starts at require time: call start().
const { checkTimeZone, normalizeSchedule, nextRun } = require('./schedule');

class SchedulerError extends Error {
  constructor(code, message) { super(message || code); this.name = 'SchedulerError'; this.code = code; }
}
const toMs = (value) => value instanceof Date ? value.getTime() : value;
const copy = (value) => value == null ? null : JSON.parse(JSON.stringify(value));

/** In-process lock. `acquire(key)` resolves to `{ release() }`, or to `null` when the key is already held. */
function createMemoryLock() {
  const held = new Set();
  return {
    async acquire(key) {
      if (held.has(key)) return null;
      held.add(key);
      let done = false;
      return { async release() { if (!done) { done = true; held.delete(key); } } };
    }
  };
}
/** Run state per task, kept in memory. A shared store (see createPostgresScheduleStore) is needed with several processes. */
function createMemoryScheduleStore() {
  const states = new Map();
  return { async get(id) { return copy(states.get(id)); }, async set(id, state) { states.set(id, copy(state)); } };
}
function createScheduler(options = {}) {
  if (!Array.isArray(options.tasks) || !options.tasks.length) throw new Error('tasks is required.');
  const defaultZone = checkTimeZone(options.timeZone ?? 'UTC');
  if (options.lock && typeof options.lock.acquire !== 'function') throw new Error('lock must have acquire(key).');
  const lock = options.lock ?? createMemoryLock();
  const store = options.store ?? createMemoryScheduleStore();
  const now = () => toMs((options.now ?? Date.now)());
  const tickMs = options.tickMs ?? 30000;
  const maxLateMs = options.maxLateMs ?? 3600000;
  const stopCheckMs = options.stopCheckMs ?? 1000;
  if (!Number.isFinite(tickMs) || tickMs <= 0 || !Number.isFinite(stopCheckMs) || stopCheckMs <= 0 || !(maxLateMs >= 0)) throw new Error('Invalid tickMs, stopCheckMs or maxLateMs.');
  const emit = (event) => { try { void Promise.resolve(options.onEvent?.(event)).catch(() => {}); } catch (_error) { /* An observer never breaks the scheduler. */ } };
  const tasks = new Map();
  for (const task of options.tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || typeof task.run !== 'function') throw new Error('Each task needs an id and a run function.');
    if (tasks.has(task.id)) throw new Error(`Duplicate task id: ${task.id}.`);
    normalizeSchedule(task.schedule);
    tasks.set(task.id, { id: task.id, label: task.label ?? task.id, run: task.run, enabled: task.enabled !== false, timeZone: checkTimeZone(task.timeZone ?? defaultZone), maxLateMs: task.maxLateMs ?? maxLateMs, schedule: task.schedule });
  }
  const controllers = new Set();
  let timer = null;
  let ticking = null;
  const upcoming = (task, from) => nextRun(task.schedule, from, task.timeZone);
  const stopped = async () => { try { return Boolean(await options.shouldStop?.()); } catch (_error) { return true; } }; // Fail closed.
  const blank = (task) => ({ id: task.id, status: 'scheduled', nextRunAt: null, lastStartedAt: null, lastRunAt: null, lastResult: null, lastError: null, skipReason: null, lastManual: false });
  const read = async (task) => ({ ...blank(task), ...(await store.get(task.id)) });
  const find = (id) => { const task = tasks.get(id); if (!task) throw new SchedulerError('unknown_task'); return task; };

  async function skip(task, reason, state) {
    await store.set(task.id, { ...state, status: 'skipped', skipReason: reason, nextRunAt: upcoming(task, now()) });
    emit({ type: 'skipped', id: task.id, reason });
    return { id: task.id, status: 'skipped', reason };
  }
  async function execute(task, { manual, signal }) {
    if (await stopped()) {
      if (manual) throw new SchedulerError('stopped');
      return skip(task, 'stopped', await read(task));
    }
    const held = await lock.acquire(task.id);
    if (!held) { if (manual) throw new SchedulerError('running'); return { id: task.id, status: 'locked' }; }
    const controller = new globalThis.AbortController();
    controllers.add(controller);
    let poll;
    let relay;
    try {
      const state = await read(task); // Read under the lock: another process may have just run it.
      const startedAt = now();
      if (!manual && state.nextRunAt && state.nextRunAt > startedAt) return { id: task.id, status: 'already_done' };
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else { relay = () => controller.abort(signal.reason); signal.addEventListener('abort', relay, { once: true }); }
      }
      poll = setInterval(() => { stopped().then((yes) => { if (yes) controller.abort(new SchedulerError('stopped')); }); }, stopCheckMs);
      poll.unref?.();
      await store.set(task.id, { ...state, status: 'running', lastStartedAt: startedAt, lastManual: manual });
      emit({ type: 'start', id: task.id, manual });
      let status = 'ok';
      let result = state.lastResult;
      let error = null;
      let reason = null;
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        result = copy(await task.run({ id: task.id, signal: controller.signal, manual, scheduledFor: state.nextRunAt, previous: state.lastResult, now: startedAt }));
      } catch (caught) {
        if (controller.signal.aborted) { status = 'skipped'; reason = 'stopped'; } else { status = 'error'; error = { message: String(caught?.message ?? caught), at: now() }; }
      }
      const finished = now();
      await store.set(task.id, {
        ...state, status, lastStartedAt: startedAt, lastManual: manual,
        lastRunAt: status === 'skipped' ? state.lastRunAt : finished, lastResult: status === 'ok' ? result : state.lastResult,
        lastError: status === 'ok' ? null : (error ?? state.lastError), skipReason: reason,
        nextRunAt: !manual || !state.nextRunAt ? upcoming(task, finished) : state.nextRunAt
      });
      emit({ type: status === 'ok' ? 'done' : status, id: task.id, manual, ...(error ? { error: error.message } : {}) });
      return { id: task.id, status, ...(status === 'ok' ? { result } : {}), ...(error ? { error: error.message } : {}), ...(reason ? { reason } : {}) };
    } finally {
      clearInterval(poll);
      if (relay) signal.removeEventListener('abort', relay);
      controllers.delete(controller);
      await held.release();
    }
  }
  async function pass() {
    const results = [];
    for (const task of tasks.values()) {
      if (!task.enabled) continue;
      try {
        const at = now();
        const state = await read(task);
        if (!state.nextRunAt) { await store.set(task.id, { ...state, nextRunAt: upcoming(task, at) }); results.push({ id: task.id, status: 'scheduled' }); continue; }
        if (state.nextRunAt > at) continue;
        if (at - state.nextRunAt > task.maxLateMs) { results.push(await skip(task, 'late', state)); continue; }
        results.push(await execute(task, { manual: false }));
      } catch (error) { try { options.onError?.(error, task.id); } catch (_ignored) { /* An observer never breaks the scheduler. */ } }
    }
    return results;
  }
  return {
    /** One pass: plans the tasks never planned, skips the ones too late, runs the ones due. Resolves to what happened. */
    tick() { if (!ticking) ticking = pass().finally(() => { ticking = null; }); return ticking; },
    /** Starts the periodic pass (and one right away). Never called by the package itself. */
    start() { if (timer) return; timer = setInterval(() => { void this.tick(); }, tickMs); timer.unref?.(); void this.tick(); },
    /** Stops the periodic pass. A run in progress goes on; use abortAll() to cut it. */
    stop() { if (timer) clearInterval(timer); timer = null; },
    get started() { return timer !== null; },
    /** Aborts every run in progress in this process (their `signal` aborts). */
    abortAll(reason = new SchedulerError('stopped')) { for (const c of controllers) c.abort(reason); },
    /** Manual run. Throws SchedulerError: unknown_task, stopped, running. Does not move the next planned run. */
    async run(id, { signal } = {}) { return execute(find(id), { manual: true, signal }); },
    /** State of one task, or of all of them. `nextRunAt` is computed when the task was never planned. */
    async state(id) {
      const describe = async (task) => { const s = await read(task); return { ...s, label: task.label, enabled: task.enabled, timeZone: task.timeZone, nextRunAt: s.nextRunAt ?? (task.enabled ? upcoming(task, now()) : null) }; };
      if (id !== undefined) return describe(find(id));
      return Promise.all([...tasks.values()].map(describe));
    }
  };
}
module.exports = { SchedulerError, createScheduler, createMemoryLock, createMemoryScheduleStore };
