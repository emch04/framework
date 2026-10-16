'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApprovalQueue, createMemoryApprovalStore, ApprovalError, ApprovalRefused, createScheduler } = require('../src');

const code = (expected) => (error) => error instanceof ApprovalError && error.code === expected;
function setup(extra = {}) {
  let t = Date.parse('2026-10-16T10:00:00Z');
  const now = () => t;
  now.add = (ms) => { t += ms; };
  const calls = [];
  const events = [];
  const queue = createApprovalQueue({ now, onEvent: (e) => events.push(e.type), executors: { send: async (ctx) => { calls.push(ctx); return { sent: ctx.input.to }; } }, ...extra });
  return { now, calls, events, queue };
}
const propose = (queue, extra = {}) => queue.propose({ type: 'send', input: { to: 'a' }, requestedBy: 'agent', ttlMs: 60000, ...extra });

test('propose records a pending action with its expiry and validates its input', async () => {
  const { queue, now } = setup();
  const action = await propose(queue, { meta: { why: 'test' } });
  assert.equal(action.status, 'pending');
  assert.equal(action.expiresAt, now() + 60000);
  assert.deepEqual(action.input, { to: 'a' });
  assert.deepEqual(await queue.get(action.id), action);
  assert.equal((await propose(queue, { ttlMs: undefined })).expiresAt, null);
  assert.equal((await propose(queue, { ttlMs: undefined, expiresAt: new Date(now() + 5) })).expiresAt, now() + 5);
  await assert.rejects(queue.propose({ type: '', requestedBy: 'x' }), code('invalid'));
  await assert.rejects(queue.propose({ type: 'send' }), code('invalid'));
  await assert.rejects(propose(queue, { ttlMs: -1 }), code('invalid'));
  await assert.rejects(queue.propose({ type: 'unknown', requestedBy: 'x' }), code('no_executor'));
  assert.deepEqual((await queue.list({ status: 'pending' })).length, 3);
  assert.equal((await queue.list({ type: 'other' })).length, 0);
});

test('approve runs the caller executor once and records the result, even when approvals are concurrent', async () => {
  const { queue, calls, events } = setup();
  const action = await propose(queue);
  const settled = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => queue.approve(action.id, { decider: `owner${n}` })));
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
  for (const s of settled.filter((x) => x.status === 'rejected')) assert.equal(s.reason.code, 'already_decided');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, action.id);
  assert.deepEqual(calls[0].input, { to: 'a' });
  assert.ok(calls[0].signal instanceof globalThis.AbortSignal);
  const done = await queue.get(action.id);
  assert.equal(done.status, 'approved');
  assert.deepEqual(done.result, { sent: 'a' });
  assert.ok(done.executedAt);
  assert.match(done.decidedBy, /^owner/);
  await assert.rejects(queue.approve(action.id, { decider: 'late' }), code('already_decided'));
  await assert.rejects(queue.reject(action.id, { decider: 'late' }), code('already_decided'));
  assert.deepEqual(events, ['proposed', 'approved']);
});

test('approve and reject racing on the same action: exactly one wins', async () => {
  const { queue, calls } = setup();
  const action = await propose(queue);
  const [a, r] = await Promise.allSettled([queue.approve(action.id, { decider: 'o' }), queue.reject(action.id, { decider: 'p', reason: 'no' })]);
  assert.equal([a, r].filter((x) => x.status === 'fulfilled').length, 1);
  const final = await queue.get(action.id);
  assert.equal(calls.length, final.status === 'approved' ? 1 : 0);
  assert.ok(['approved', 'rejected'].includes(final.status));
});

test('reject records who and why, and nothing runs', async () => {
  const { queue, calls } = setup();
  const action = await propose(queue);
  const rejected = await queue.reject(action.id, { decider: { id: 'owner', role: 'owner' }, reason: 'too much' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.decidedBy, 'owner');
  assert.equal(rejected.reason, 'too much');
  assert.equal(calls.length, 0);
  await assert.rejects(queue.approve(action.id, { decider: 'owner' }), code('already_decided'));
  await assert.rejects(queue.approve('missing', { decider: 'owner' }), code('not_found'));
});

test('the caller decides who may decide: authorize is called with the decider and can forbid', async () => {
  const seen = [];
  const { queue, calls } = setup({ authorize: ({ action, decider, decision }) => { seen.push([action.type, decider.role, decision]); return decider.role === 'owner'; } });
  const action = await propose(queue);
  await assert.rejects(queue.approve(action.id, { decider: { id: 'u', role: 'staff' } }), code('forbidden'));
  await assert.rejects(queue.reject(action.id, { decider: { id: 'u', role: 'staff' } }), code('forbidden'));
  await assert.rejects(queue.approve(action.id, {}), code('invalid'));
  assert.equal((await queue.get(action.id)).status, 'pending');
  assert.equal(calls.length, 0);
  await queue.approve(action.id, { decider: { id: 'o', role: 'owner' } });
  assert.deepEqual(seen.slice(0, 2), [['send', 'staff', 'approve'], ['send', 'staff', 'reject']]);
  const thrower = setup({ authorize: () => { throw new Error('session expired'); } });
  await assert.rejects(thrower.queue.approve((await propose(thrower.queue)).id, { decider: 'o' }), code('forbidden'));
});

test('an executor that refuses puts the action back to pending with the reason; a later approval can succeed', async () => {
  let complete = false;
  const { queue, events } = setup({ executors: { send: async () => { if (!complete) throw new ApprovalRefused('incomplete', { missing: ['address'] }); return { done: true }; } } });
  const action = await propose(queue);
  await assert.rejects(queue.approve(action.id, { decider: 'o' }), (e) => e instanceof ApprovalRefused && e.details.missing[0] === 'address');
  const back = await queue.get(action.id);
  assert.equal(back.status, 'pending');
  assert.equal(back.decidedBy, null);
  assert.equal(back.executedAt, null);
  assert.equal(back.refusal.reason, 'incomplete');
  assert.deepEqual(back.refusal.details, { missing: ['address'] });
  assert.equal(back.refusal.by, 'o');
  complete = true;
  const { result } = await queue.approve(action.id, { decider: 'o2' });
  assert.deepEqual(result, { done: true });
  assert.ok(events.includes('refused'));
});

test('an executor that crashes is not retried silently: pending again, error wrapped', async () => {
  const { queue, events } = setup({ executors: { send: async () => { throw new Error('network down'); } } });
  const action = await propose(queue);
  await assert.rejects(queue.approve(action.id, { decider: 'o' }), (e) => e.code === 'execution_failed' && /network down/.test(e.cause.message));
  assert.equal((await queue.get(action.id)).status, 'pending');
  assert.equal((await queue.get(action.id)).refusal.reason, 'execution_failed');
  assert.ok(events.includes('failed'));
});

test('beforeExecute (an emergency stop, say) runs after the reservation and can cancel it', async () => {
  let stopped = true;
  const { queue, calls } = setup({ beforeExecute: () => { if (stopped) throw new ApprovalError('stopped'); } });
  const action = await propose(queue);
  await assert.rejects(queue.approve(action.id, { decider: 'o' }), code('stopped'));
  assert.equal((await queue.get(action.id)).status, 'pending');
  assert.equal(calls.length, 0);
  stopped = false;
  await queue.approve(action.id, { decider: 'o' });
  assert.equal(calls.length, 1);
});

test('expired actions can no longer be decided; listing and approving sweep them', async () => {
  const { queue, now, calls, events } = setup();
  const a = await propose(queue, { ttlMs: 1000 });
  const b = await propose(queue, { ttlMs: 5000 });
  const forever = await propose(queue, { ttlMs: undefined });
  now.add(1000); // exactly at the expiry
  await assert.rejects(queue.approve(a.id, { decider: 'o' }), code('expired'));
  assert.equal((await queue.get(a.id)).status, 'expired');
  await assert.rejects(queue.reject(a.id, { decider: 'o' }), code('expired'));
  assert.equal(calls.length, 0);
  now.add(10000);
  assert.deepEqual((await queue.list({ status: 'pending' })).map((x) => x.id), [forever.id]);
  assert.equal((await queue.get(b.id)).status, 'expired');
  assert.deepEqual(events.filter((e) => e === 'expired').length, 2);
  assert.deepEqual(await queue.expire(), []);
  await queue.approve(forever.id, { decider: 'o' });
});

test('an action expiring between the check and the reservation is not run', async () => {
  const store = createMemoryApprovalStore();
  const { queue, now, calls } = setup({ store });
  const action = await propose(queue, { ttlMs: 1000 });
  const reserve = store.reserve;
  store.reserve = async (id, by, at) => { now.add(1000); return reserve(id, by, at + 1000); }; // the clock passes the expiry after the checks
  await assert.rejects(queue.approve(action.id, { decider: 'o' }), code('expired'));
  assert.equal(calls.length, 0);
});

test('the sweep can run from the scheduler', async () => {
  const { queue, now } = setup();
  const a = await propose(queue, { ttlMs: 1000 });
  const scheduler = createScheduler({ now, tasks: [{ id: 'expire', schedule: { type: 'interval', everyMs: 500 }, run: async () => ({ expired: (await queue.expire()).length }) }] });
  await scheduler.tick();
  now.add(1500);
  assert.deepEqual((await scheduler.tick())[0].result, { expired: 1 });
  assert.equal((await queue.get(a.id)).status, 'expired');
});

test('list pages through the actions, most recent first', async () => {
  const { queue, now } = setup();
  const ids = [];
  for (let i = 0; i < 5; i += 1) { ids.push((await propose(queue, { ttlMs: undefined, requestedBy: i % 2 ? 'x' : 'y' })).id); now.add(10); }
  const first = await queue.list({ limit: 2 });
  assert.deepEqual(first.map((x) => x.id), [ids[4], ids[3]]);
  const second = await queue.list({ limit: 2, before: first[1].createdAt });
  assert.deepEqual(second.map((x) => x.id), [ids[2], ids[1]]);
  assert.equal((await queue.list({ requestedBy: 'x' })).length, 2);
});

test('a single executor function handles every type; wrong configuration is refused', async () => {
  const queue = createApprovalQueue({ executors: async ({ action }) => action.type });
  const action = await queue.propose({ type: 'anything', requestedBy: 'a' });
  assert.equal((await queue.approve(action.id, { decider: 'o' })).result, 'anything');
  const bare = createApprovalQueue({});
  const lonely = await bare.propose({ type: 'x', requestedBy: 'a' });
  await assert.rejects(bare.approve(lonely.id, { decider: 'o' }), code('no_executor'));
  assert.throws(() => createApprovalQueue({ executors: { send: 1 } }), /executors/);
  assert.throws(() => createApprovalQueue({ authorize: 1 }), /authorize/);
});
