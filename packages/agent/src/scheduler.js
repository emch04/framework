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
    // `enabled` and `schedule` may be functions (sync or async): read again before every pass, so a setting
    // changed in an admin applies without rebuilding the scheduler. A plain value is checked right away.
    if (typeof task.schedule !== 'function') normalizeSchedule(task.schedule);
    if (task.enabled !== undefined && typeof task.enabled !== 'boolean' && typeof task.enabled !== 'function') throw new Error(`${task.id}: enabled must be a boolean or a function.`);
    tasks.set(task.id, { id: task.id, label: task.label ?? task.id, run: task.run, enabled: task.enabled ?? true, timeZone: checkTimeZone(task.timeZone ?? defaultZone), maxLateMs: task.maxLateMs ?? maxLateMs, schedule: task.schedule });
  }
  const controllers = new Set();
  let timer = null;
  let ticking = null;
  /** The task as it stands now: `enabled` and `schedule` resolved, the schedule checked, plus a key that changes with it. */
  async function live(task) {
    const enabled = typeof task.enabled === 'function' ? await task.enabled({ id: task.id }) : task.enabled;
    if (typeof enabled !== 'boolean') throw new Error(`${task.id}: enabled() must resolve to a boolean.`);
    const schedule = typeof task.schedule === 'function' ? await task.schedule({ id: task.id }) : task.schedule;
    const key = JSON.stringify({ ...normalizeSchedule(schedule), timeZone: task.timeZone });
    return { enabled, schedule, key };
  }
  const upcoming = (task, from, current) => nextRun(current.schedule, from, task.timeZone);
  const stopped = async () => { try { return Boolean(await options.shouldStop?.()); } catch (_error) { return true; } }; // Fail closed.
  const blank = (task) => ({ id: task.id, status: 'scheduled', nextRunAt: null, lastStartedAt: null, lastRunAt: null, lastResult: null, lastError: null, skipReason: null, lastManual: false });
  const read = async (task) => ({ ...blank(task), ...(await store.get(task.id)) });
  const find = (id) => { const task = tasks.get(id); if (!task) throw new SchedulerError('unknown_task'); return task; };

  async function skip(task, reason, state, current) {
    await store.set(task.id, { ...state, status: 'skipped', skipReason: reason, nextRunAt: upcoming(task, now(), current), scheduleKey: current.key });
    emit({ type: 'skipped', id: task.id, reason });
    return { id: task.id, status: 'skipped', reason };
  }
  async function execute(task, { manual, signal, current }) {
    if (await stopped()) {
      if (manual) throw new SchedulerError('stopped');
      return skip(task, 'stopped', await read(task), current);
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
        nextRunAt: !manual || !state.nextRunAt ? upcoming(task, finished, current) : state.nextRunAt,
        scheduleKey: !manual || !state.nextRunAt ? current.key : state.scheduleKey
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
      try {
        const current = await live(task);
        const at = now();
        const state = await read(task);
        if (!current.enabled) {
          // Forget the plan: switched back on, the task is planned afresh instead of being skipped as late.
          if (state.nextRunAt != null) await store.set(task.id, { ...state, nextRunAt: null, scheduleKey: null });
          continue;
        }
        // A state written before scheduleKey existed keeps its plan; a changed schedule is planned again.
        const changed = state.nextRunAt != null && state.scheduleKey != null && state.scheduleKey !== current.key;
        if (!state.nextRunAt || changed) {
          await store.set(task.id, { ...state, nextRunAt: upcoming(task, at, current), scheduleKey: current.key });
          results.push({ id: task.id, status: changed ? 'rescheduled' : 'scheduled' });
          continue;
        }
        if (state.nextRunAt > at) { if (state.scheduleKey == null) await store.set(task.id, { ...state, scheduleKey: current.key }); continue; }
        if (at - state.nextRunAt > task.maxLateMs) { results.push(await skip(task, 'late', state, current)); continue; }
        results.push(await execute(task, { manual: false, current }));
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
    /** Manual run (also allowed while the task is disabled). Throws SchedulerError: unknown_task, stopped, running. Does not move the next planned run. */
    async run(id, { signal } = {}) { const task = find(id); return execute(task, { manual: true, signal, current: await live(task) }); },
    /** State of one task, or of all of them. `nextRunAt` is computed when the task was never planned. */
    async state(id) {
      const describe = async (task) => {
        const s = await read(task);
        const current = await live(task);
        return { ...s, label: task.label, enabled: current.enabled, schedule: copy(current.schedule), timeZone: task.timeZone, nextRunAt: current.enabled ? (s.nextRunAt ?? upcoming(task, now(), current)) : null };
      };
      if (id !== undefined) return describe(find(id));
      return Promise.all([...tasks.values()].map(describe));
    }
  };
}
module.exports = { SchedulerError, createScheduler, createMemoryLock, createMemoryScheduleStore };
