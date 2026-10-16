'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler, createMemoryLock, createMemoryScheduleStore, SchedulerError, nextRun, zonedTime } = require('../src');

const PARIS = 'Europe/Paris';
const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
function clock(start) { let t = at(start); const now = () => t; now.set = (iso2) => { t = at(iso2); }; now.add = (ms) => { t += ms; }; return now; }

test('daily schedule follows the wall clock across the autumn and spring time changes', () => {
  // Paris leaves summer time on 2026-10-25 (03:00 -> 02:00) and enters it on 2026-03-29 (02:00 -> 03:00).
  const daily = { type: 'daily', at: '07:00' };
  assert.equal(iso(nextRun(daily, at('2026-10-24T10:00:00Z'), PARIS)), '2026-10-25T06:00:00.000Z'); // 07:00 CET after the change
  assert.equal(iso(nextRun(daily, at('2026-10-23T10:00:00Z'), PARIS)), '2026-10-24T05:00:00.000Z'); // 07:00 CEST before it
  assert.equal(iso(nextRun(daily, at('2026-10-25T06:00:00Z'), PARIS)), '2026-10-26T06:00:00.000Z'); // strictly after
  assert.equal(iso(nextRun(daily, at('2026-03-28T10:00:00Z'), PARIS)), '2026-03-29T05:00:00.000Z'); // 07:00 CEST
  assert.equal(iso(nextRun(daily, at('2026-03-27T10:00:00Z'), PARIS)), '2026-03-28T06:00:00.000Z'); // 07:00 CET
  assert.equal(iso(nextRun(daily, at('2026-07-01T00:00:00Z'), 'UTC')), '2026-07-01T07:00:00.000Z');
  assert.equal(iso(nextRun(daily, at('2026-03-08T12:00:00Z'), 'America/New_York')), '2026-03-09T11:00:00.000Z'); // 07:00 EDT
  assert.equal(iso(nextRun(daily, at('2026-03-07T12:30:00Z'), 'America/New_York')), '2026-03-08T11:00:00.000Z'); // the change day itself
  assert.equal(iso(nextRun(daily, at('2026-03-07T12:30:00Z'), 'Pacific/Kiritimati')), '2026-03-07T17:00:00.000Z'); // UTC+14
});

test('a wall time that does not exist runs after the gap, one that happens twice runs once, at its first occurrence', () => {
  const night = { type: 'daily', at: '02:30' };
  assert.equal(iso(nextRun(night, at('2026-03-29T00:00:00Z'), PARIS)), '2026-03-29T01:30:00.000Z'); // 02:30 does not exist: 03:30 CEST
  assert.equal(iso(nextRun(night, at('2026-10-25T00:00:00Z'), PARIS)), '2026-10-25T00:30:00.000Z'); // 02:30 CEST, first of two
  assert.equal(iso(nextRun(night, at('2026-10-25T00:30:00Z'), PARIS)), '2026-10-26T01:30:00.000Z'); // not again at 02:30 CET
  assert.equal(iso(zonedTime('2026-10-25', 2, 30, PARIS)), '2026-10-25T00:30:00.000Z');
});

test('weekly schedule picks the day in the zone, interval adds its delay, bad schedules are refused', () => {
  const monday = { type: 'weekly', day: 1, at: '07:00' };
  assert.equal(iso(nextRun(monday, at('2026-10-16T12:00:00Z'), PARIS)), '2026-10-19T05:00:00.000Z'); // Friday -> Monday 07:00 CEST
  assert.equal(iso(nextRun(monday, at('2026-10-19T05:00:00Z'), PARIS)), '2026-10-26T06:00:00.000Z'); // next Monday is in winter time
  assert.equal(iso(nextRun({ type: 'weekly', days: ['saturday', 7], at: '9:05' }, at('2026-10-16T12:00:00Z'), PARIS)), '2026-10-17T07:05:00.000Z');
  assert.equal(nextRun({ type: 'interval', everyMs: 600000 }, 1000), 601000);
  for (const bad of [null, { type: 'monthly' }, { type: 'daily', at: '25:00' }, { type: 'daily' }, { type: 'weekly', at: '07:00' }, { type: 'weekly', day: 8, at: '07:00' }, { type: 'interval', everyMs: 0 }]) assert.throws(() => nextRun(bad, 0), undefined, JSON.stringify(bad));
  assert.throws(() => nextRun({ type: 'daily', at: '07:00' }, 0, 'Mars/Olympus'), /time zone/);
});

function build(extra = {}) {
  const now = clock('2026-10-16T04:00:00Z');
  const runs = [];
  const scheduler = createScheduler({ now, timeZone: PARIS, tickMs: 10, stopCheckMs: 5, tasks: [{ id: 'morning', schedule: { type: 'daily', at: '07:00' }, run: async (ctx) => { runs.push(ctx); return { n: runs.length }; } }], ...extra });
  return { now, runs, scheduler };
}

test('nothing starts by itself; the first pass plans, a later pass runs the task when it is due', async () => {
  const { now, runs, scheduler } = build();
  assert.equal(scheduler.started, false);
  assert.deepEqual(await scheduler.tick(), [{ id: 'morning', status: 'scheduled' }]);
  assert.equal(iso((await scheduler.state('morning')).nextRunAt), '2026-10-16T05:00:00.000Z'); // 07:00 Paris today
  assert.deepEqual(await scheduler.tick(), []); // not due yet
  assert.equal(runs.length, 0);
  now.set('2026-10-16T05:00:30Z');
  const [done] = await scheduler.tick();
  assert.deepEqual(done, { id: 'morning', status: 'ok', result: { n: 1 } });
  assert.equal(runs[0].manual, false);
  assert.equal(runs[0].previous, null);
  assert.ok(runs[0].signal instanceof globalThis.AbortSignal);
  const state = await scheduler.state('morning');
  assert.equal(state.status, 'ok');
  assert.equal(state.lastRunAt, now());
  assert.deepEqual(state.lastResult, { n: 1 });
  assert.equal(iso(state.nextRunAt), '2026-10-17T05:00:00.000Z');
  assert.deepEqual(await scheduler.tick(), []); // not twice the same day
  now.set('2026-10-17T05:00:00Z');
  await scheduler.tick();
  assert.deepEqual(runs[1].previous, { n: 1 });
});

test('the next run after the autumn time change is 07:00 winter time', async () => {
  const { now, scheduler } = build();
  now.set('2026-10-24T05:00:00Z');
  await scheduler.tick(); // plans
  now.set('2026-10-24T05:00:01Z'); // 07:00 CEST has just passed: planned for the next day
  const state = await scheduler.state('morning');
  assert.equal(iso(state.nextRunAt), '2026-10-25T06:00:00.000Z');
  now.set('2026-10-25T06:00:00Z');
  assert.equal((await scheduler.tick())[0].status, 'ok');
  assert.equal(iso((await scheduler.state('morning')).nextRunAt), '2026-10-26T06:00:00.000Z');
});

test('a run missed beyond the delay is skipped, within the delay it still runs', async () => {
  const { now, runs, scheduler } = build({ maxLateMs: 3600000 });
  await scheduler.tick();
  now.set('2026-10-16T05:59:00Z'); // 59 minutes late
  assert.equal((await scheduler.tick())[0].status, 'ok');
  assert.equal(runs.length, 1);
  now.set('2026-10-17T09:00:00Z'); // server was off: 4 hours late
  assert.deepEqual(await scheduler.tick(), [{ id: 'morning', status: 'skipped', reason: 'late' }]);
  assert.equal(runs.length, 1);
  const state = await scheduler.state('morning');
  assert.equal(state.skipReason, 'late');
  assert.equal(iso(state.nextRunAt), '2026-10-18T05:00:00.000Z');
  assert.equal(iso(state.lastRunAt), '2026-10-16T05:59:00.000Z');
});

test('a task can have its own delay, zone and be disabled', async () => {
  const now = clock('2026-10-16T05:00:00Z');
  const ran = [];
  const scheduler = createScheduler({ now, tasks: [
    { id: 'tokyo', timeZone: 'Asia/Tokyo', maxLateMs: 0, schedule: { type: 'daily', at: '09:00' }, run: () => { ran.push('tokyo'); } },
    { id: 'off', enabled: false, schedule: { type: 'interval', everyMs: 1 }, run: () => { ran.push('off'); } }
  ] });
  await scheduler.tick();
  assert.equal(iso((await scheduler.state('tokyo')).nextRunAt), '2026-10-17T00:00:00.000Z'); // 09:00 JST
  assert.equal((await scheduler.state('off')).nextRunAt, null);
  now.set('2026-10-17T00:00:01Z');
  assert.equal((await scheduler.tick())[0].reason, 'late'); // maxLateMs 0
  assert.deepEqual(ran, []);
});

test('a task never runs twice at once: manual and scheduled runs meet the lock', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { now, scheduler } = build({ tasks: [{ id: 'slow', schedule: { type: 'interval', everyMs: 1000 }, run: () => gate }] });
  await scheduler.tick();
  now.add(1000);
  const first = scheduler.tick();
  await tick();
  await assert.rejects(scheduler.run('slow'), (e) => e instanceof SchedulerError && e.code === 'running');
  assert.equal((await scheduler.state('slow')).status, 'running');
  release('done');
  assert.equal((await first)[0].result, 'done');
  assert.equal((await scheduler.run('slow')).result, 'done'); // the lock was released
});

test('two schedulers sharing a lock and a store run the due task once', async () => {
  const lock = createMemoryLock();
  const store = createMemoryScheduleStore();
  const now = clock('2026-10-16T05:00:00Z');
  let count = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const make = () => createScheduler({ now, lock, store, tasks: [{ id: 'job', schedule: { type: 'interval', everyMs: 1000 }, run: async () => { count += 1; await gate; } }] });
  const a = make();
  const b = make();
  await a.tick();
  now.add(1000);
  const running = a.tick();
  await tick();
  assert.deepEqual(await b.tick(), [{ id: 'job', status: 'locked' }]);
  release();
  await running;
  assert.deepEqual(await b.tick(), []); // finished by a: the shared state says it is not due
  assert.equal(count, 1);
  // Race: b read the stale "due" state before taking the lock after a had finished.
  const stale = { ...(await store.get('job')), nextRunAt: now() - 1 };
  await store.set('job', stale);
  const fresh = make();
  const raced = await Promise.all([fresh.tick(), a.tick()]);
  assert.equal(count, 2, JSON.stringify(raced));
});

test('the global stop is checked before a run, for scheduled and manual runs', async () => {
  let stop = false;
  const { now, runs, scheduler } = build({ shouldStop: () => stop });
  await scheduler.tick();
  stop = true;
  now.set('2026-10-16T05:00:30Z');
  assert.deepEqual(await scheduler.tick(), [{ id: 'morning', status: 'skipped', reason: 'stopped' }]);
  assert.equal((await scheduler.state('morning')).skipReason, 'stopped');
  await assert.rejects(scheduler.run('morning'), (e) => e.code === 'stopped');
  assert.equal(runs.length, 0);
  stop = false;
  assert.equal((await scheduler.run('morning')).status, 'ok');
});

test('a failing stop check stops (fail closed)', async () => {
  const { scheduler } = build({ shouldStop: async () => { throw new Error('settings unreadable'); } });
  await assert.rejects(scheduler.run('morning'), (e) => e.code === 'stopped');
});

test('the global stop during a run aborts its signal; the run is skipped and not counted as done', async () => {
  let stop = false;
  let seen;
  const { scheduler } = build({ shouldStop: () => stop, tasks: [{ id: 'long', schedule: { type: 'interval', everyMs: 1000 }, run: ({ signal }) => new Promise((resolve, reject) => { seen = signal; signal.addEventListener('abort', () => reject(signal.reason)); }) }] });
  const running = scheduler.run('long');
  await tick();
  stop = true;
  const result = await running;
  assert.deepEqual(result, { id: 'long', status: 'skipped', reason: 'stopped' });
  assert.equal(seen.aborted, true);
  assert.ok(seen.reason instanceof SchedulerError);
  const state = await scheduler.state('long');
  assert.equal(state.lastRunAt, null);
  assert.equal(state.lastError, null);
});

test('abortAll() cuts runs in progress, and an outside signal reaches the task', async () => {
  let signals = [];
  const wait = ({ signal }) => new Promise((resolve, reject) => { signals.push(signal); signal.addEventListener('abort', () => reject(signal.reason)); });
  const { scheduler } = build({ tasks: [{ id: 'a', schedule: { type: 'interval', everyMs: 1000 }, run: wait }, { id: 'b', schedule: { type: 'interval', everyMs: 1000 }, run: wait }] });
  const one = scheduler.run('a');
  await tick();
  scheduler.abortAll();
  assert.equal((await one).status, 'skipped');
  const outside = new globalThis.AbortController();
  signals = [];
  const two = scheduler.run('b', { signal: outside.signal });
  await tick();
  outside.abort(new Error('caller left'));
  assert.equal((await two).status, 'skipped');
  assert.equal(signals[0].aborted, true);
});

test('a manual run does not move the planned run; errors are recorded and the task is retried at the next time', async () => {
  let fail = true;
  const { now, scheduler } = build({ tasks: [{ id: 'job', schedule: { type: 'daily', at: '07:00' }, run: () => { if (fail) throw new Error('boom'); return { ok: true }; } }] });
  const errors = [];
  await scheduler.tick();
  const planned = (await scheduler.state('job')).nextRunAt;
  const manual = await scheduler.run('job');
  assert.deepEqual(manual, { id: 'job', status: 'error', error: 'boom' });
  const state = await scheduler.state('job');
  assert.equal(state.nextRunAt, planned);
  assert.equal(state.lastManual, true);
  assert.equal(state.lastError.message, 'boom');
  await assert.rejects(scheduler.run('nope'), (e) => e.code === 'unknown_task');
  fail = false;
  now.set('2026-10-16T05:00:10Z');
  assert.equal((await scheduler.tick())[0].status, 'ok');
  const after = await scheduler.state('job');
  assert.equal(after.lastError, null);
  assert.deepEqual(after.lastResult, { ok: true });
  assert.ok(after.nextRunAt > planned);
  assert.deepEqual(errors, []);
});

test('start() runs passes on a timer and stop() ends them; the loader never starts anything', async () => {
  const events = [];
  const scheduler = createScheduler({ tickMs: 5, tasks: [{ id: 'fast', schedule: { type: 'interval', everyMs: 10 }, run: () => { events.push(1); } }] });
  assert.equal(scheduler.started, false);
  scheduler.start();
  scheduler.start();
  assert.equal(scheduler.started, true);
  await tick(80);
  scheduler.stop();
  assert.equal(scheduler.started, false);
  const count = events.length;
  assert.ok(count >= 1);
  await tick(40);
  assert.equal(events.length, count);
});

test('invalid configuration is refused', () => {
  const run = () => {};
  const schedule = { type: 'interval', everyMs: 1 };
  assert.throws(() => createScheduler({}), /tasks/);
  assert.throws(() => createScheduler({ tasks: [{ id: 'a', schedule }] }), /run/);
  assert.throws(() => createScheduler({ tasks: [{ id: 'a', schedule, run }, { id: 'a', schedule, run }] }), /Duplicate/);
  assert.throws(() => createScheduler({ tasks: [{ id: 'a', schedule: { type: 'daily', at: 'noon' }, run }] }), /HH:MM/);
  assert.throws(() => createScheduler({ timeZone: 'Nowhere/Land', tasks: [{ id: 'a', schedule, run }] }), /time zone/);
  assert.throws(() => createScheduler({ lock: {}, tasks: [{ id: 'a', schedule, run }] }), /lock/);
});
