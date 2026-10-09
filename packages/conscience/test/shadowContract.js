'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeConscience, mask, makeClock, policy } = require('./helpers');
const api = require('../src/autoconscience');

const ORG = 'org-a';
const human = (id) => ({ kind: 'human', id });
const engine = { kind: 'engine', id: 'reflection-engine' };
const boss = human('boss');
const PEOPLE = ['alice@example.com', 'Alice Martin'];

/* The candidate and the metrics are plain functions: the agent is serialised into the sandbox, so it closes over nothing. */
const doubling = async (request, tools) => { await tools.notify({ to: request.input.email }); return { answer: request.input.n * 2 }; };
const metrics = [
  { name: 'accuracy', score: ({ input, output }) => output.answer === input.n * 2 },
  { name: 'sources', score: ({ output }) => output.answer !== undefined }
];

function shadowContract(label, makeStores, options = {}) {
  const suite = (name, fn) => test(`${label} P4 shadow: ${name}`, { skip: options.skip }, async (t) => {
    const stores = await makeStores();
    if (stores.unavailable) { t.skip(stores.unavailable); return; }
    try {
      const ctx = makeConscience({ store: stores.store, governorStore: stores.governorStore, clock: makeClock(),
        governorPolicy: policy({ approvers: ['boss', 'boss-2'], budgets: { perCycle: 5, perAgent: 1000, perOrganisation: 1000, periodMs: 86400000 } }),
        erasers: [api.shadowEraser(stores.shadowStore)] });
      await fn({ ...ctx, stores, org: ORG });
    } finally { await stores.cleanup?.(); }
  });

  /** Register an object, get a change approved by a human and staged: its version is the candidate. */
  async function stage(ctx, { organisationId = ORG, id = 'main', change = { text: 'v2' } } = {}) {
    const { governor } = ctx;
    await governor.registerObject({ organisationId, kind: 'instructions', id, content: { text: 'v1' }, by: boss });
    const proposal = await governor.evaluatePolicy({ id: `p-${organisationId}-${id}`, organisationId, target: { kind: 'instructions', id }, change, proposedBy: engine, risk: 'low' });
    await governor.approveProposal(proposal.id, { approver: boss, organisationId });
    await governor.stageChange(proposal.id, { organisationId, by: engine });
    return proposal.id;
  }
  const sandboxOf = (ctx, extra = {}, organisationId = ORG) => api.createSandbox({ governor: ctx.governor, organisationId,
    tools: { notify: { kind: 'write' }, lookup: { kind: 'read', response: { found: true } }, ...extra } });
  async function runner(ctx, extra = {}) {
    const organisationId = extra.organisationId ?? ORG;
    return api.createShadowRunner({
      governor: ctx.governor, organisationId, candidate: { kind: 'instructions', id: 'main', agent: doubling }, sandbox: await sandboxOf(ctx, {}, organisationId),
      sampleRate: 1, budget: { maxRuns: 1000 }, masker: mask, store: ctx.stores.shadowStore, metrics, target: 'accuracy', minimumSample: 30,
      now: ctx.clock, ...extra
    });
  }
  const request = (i, extra = {}) => ({ id: `req-${i}`, userId: 'user-1', input: { n: i, email: 'alice@example.com', note: 'Alice Martin asked' }, ...extra });
  const feed = async (shadow, items) => {
    const out = [];
    for (const item of items) out.push(await shadow.observe(item).done);
    return out;
  };
  /** Stable answers right for 3 requests in 4, unless overridden. */
  const stableAnswer = (i, ok = i % 4 !== 0) => ({ output: { answer: ok ? i * 2 : -1 }, durationMs: 5, cost: 1 });
  const items = (n, stable = (i) => stableAnswer(i), req = (i) => request(i)) => Array.from({ length: n }, (_, i) => ({ request: req(i + 1), stableResult: stable(i + 1) }));

  /* ---------------- which strategy may run ---------------- */

  suite('only a strategy approved by humans may run: pending, declined, rejected, stable and unknown ones are refused', async (ctx) => {
    const { governor } = ctx;
    const base = { governor, organisationId: ORG, sandbox: await sandboxOf(ctx), sampleRate: 1, budget: { maxRuns: 5 }, masker: mask, metrics, target: 'accuracy', store: ctx.stores.shadowStore };
    const build = (candidate) => api.createShadowRunner({ ...base, candidate: { agent: doubling, ...candidate } });
    await governor.registerObject({ organisationId: ORG, kind: 'instructions', id: 'main', content: { text: 'v1' }, by: boss });
    // No candidate version yet: the stable version never runs in the shadow.
    await assert.rejects(build({ kind: 'instructions', id: 'main' }), { code: 'candidate_not_staged' });
    await assert.rejects(build({ kind: 'instructions', id: 'unknown' }), { code: 'not_found' });
    const pending = await governor.evaluatePolicy({ organisationId: ORG, target: { kind: 'instructions', id: 'main' }, change: { text: 'v2' }, proposedBy: engine, risk: 'low' });
    assert.equal(pending.status, 'pending_approval');
    await assert.rejects(build({ proposalId: pending.id }), { code: 'candidate_not_approved' });
    const declined = await governor.evaluatePolicy({ organisationId: ORG, target: { kind: 'instructions', id: 'main' }, change: { text: 'v3' }, proposedBy: engine, risk: 'low' });
    await governor.declineProposal(declined.id, { approver: boss, organisationId: ORG, reasonCode: 'not_needed' });
    await assert.rejects(build({ proposalId: declined.id }), { code: 'candidate_not_approved' });
    const rejected = await governor.evaluatePolicy({ organisationId: ORG, target: { kind: 'budgets', id: 'main' }, change: { cap: 1e9 }, proposedBy: engine });
    assert.equal(rejected.status, 'rejected');
    await assert.rejects(build({ proposalId: rejected.id }), { code: 'candidate_not_approved' });
    await assert.rejects(build({ proposalId: 'missing' }), { code: 'not_found' });
    await assert.rejects(build({}), { code: 'invalid_input' });
    await assert.rejects(build({ proposalId: pending.id, kind: 'instructions', id: 'main' }), { code: 'invalid_input' });
    // A human approves: the proposal may run in the shadow, with or without being staged.
    await governor.approveProposal(pending.id, { approver: boss, organisationId: ORG });
    const byProposal = await build({ proposalId: pending.id });
    assert.deepEqual([byProposal.candidate.source, byProposal.candidate.proposalId], ['proposal', pending.id]);
    await governor.stageChange(pending.id, { organisationId: ORG, by: engine });
    const byVersion = await build({ kind: 'instructions', id: 'main' });
    assert.deepEqual([byVersion.candidate.source, byVersion.candidate.versionId], ['version', 'v2']);
    await assert.rejects(build({ kind: 'instructions', id: 'main', versionId: 'v1' }), { code: 'candidate_not_staged' });
    // Another organisation does not see it, nor can it borrow its sandbox.
    await assert.rejects(api.createShadowRunner({ ...base, organisationId: 'org-b', candidate: { agent: doubling, proposalId: pending.id }, sandbox: await sandboxOf(ctx, {}, 'org-b') }), { code: 'not_found' });
    await assert.rejects(api.createShadowRunner({ ...base, organisationId: 'org-b', candidate: { agent: doubling, kind: 'instructions', id: 'main' }, sandbox: await sandboxOf(ctx, {}, 'org-b') }), { code: 'not_found' });
  });

  suite('configuration is strict: masker, budget, sandbox, sampling, metrics and counter-measure are all required', async (ctx) => {
    await stage(ctx);
    const good = { governor: ctx.governor, organisationId: ORG, candidate: { kind: 'instructions', id: 'main', agent: doubling }, sandbox: await sandboxOf(ctx),
      sampleRate: 0.5, budget: { maxRuns: 5 }, masker: mask, metrics, target: 'accuracy', store: ctx.stores.shadowStore };
    const make = (patch) => api.createShadowRunner({ ...good, ...patch });
    assert.ok(await make({}));
    await assert.rejects(make({ masker: undefined }), { code: 'masker_required' });
    await assert.rejects(make({ budget: undefined }), { code: 'invalid_input' });
    await assert.rejects(make({ budget: {} }), { code: 'invalid_input' });
    await assert.rejects(make({ budget: { maxRuns: -1 } }), { code: 'invalid_input' });
    await assert.rejects(make({ sandbox: undefined }), { code: 'invalid_input' });
    for (const sampleRate of [0, -0.1, 1.5, NaN, '0.5', undefined]) await assert.rejects(make({ sampleRate }), { code: 'invalid_input' });
    await assert.rejects(make({ metrics: [] }), { code: 'invalid_input' });
    await assert.rejects(make({ metrics: [{ name: 'Bad Name', score: () => true }, metrics[1]] }), { code: 'invalid_input' });
    await assert.rejects(make({ metrics: [metrics[0], { name: 'accuracy', score: () => true }] }), { code: 'invalid_input' });
    await assert.rejects(make({ target: 'nope' }), { code: 'invalid_input' });
    // Anti-Goodhart: a lone target without any counter-measure is refused.
    await assert.rejects(make({ metrics: [metrics[0]] }), { code: 'invalid_input' });
    assert.ok(await make({ metrics: [metrics[0]], limits: { cost: 2 } }));
    await assert.rejects(make({ candidate: { kind: 'instructions', id: 'main', agent: 'not a function' } }), { code: 'invalid_input' });
    await assert.rejects(make({ store: {} }), { code: 'store_invalid' });
    await assert.rejects(make({ sandbox: await sandboxOf(ctx, {}, 'org-b') }), { code: 'cross_organisation' });
    await assert.rejects(make({ governor: undefined }), { code: 'governor_missing' });
    await assert.rejects(make({ governor: {} }), { code: 'governor_invalid' });
    await assert.rejects(make({ minimumSample: 0 }), { code: 'invalid_input' });
  });

  /* ---------------- the candidate answers nothing to anyone ---------------- */

  suite('the candidate answer never reaches the user: the caller gets an acknowledgement without output, and the stable answer is untouched', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx, { candidate: { kind: 'instructions', id: 'main', agent: async (r) => ({ answer: r.input.n * 2, secret: 'CANDIDATE-ONLY-MARKER' }) } });
    const stableResult = Object.freeze({ output: Object.freeze({ answer: 14 }), durationMs: 3 });
    const handle = shadow.observe({ request: request(7), stableResult });
    assert.deepEqual(Object.keys(handle).sort(), ['done', 'reason', 'scheduled']);
    assert.equal(handle.scheduled, true);
    const ack = await handle.done;
    assert.deepEqual(Object.keys(ack).sort(), ['created', 'runId', 'status']);
    assert.equal(ack.status, 'recorded');
    for (const value of [handle, ack, shadow.stats(), stableResult]) assert.ok(!JSON.stringify(value).includes('CANDIDATE-ONLY-MARKER'));
    assert.deepEqual(stableResult, { output: { answer: 14 }, durationMs: 3 });
    // The marker exists only where it belongs: in the masked journal of the shadow.
    const [run] = await shadow.listRuns();
    assert.equal(run.candidate.output.secret, 'CANDIDATE-ONLY-MARKER');
    assert.equal(run.id, ack.runId);
    // The shadow exposes no way to hand the candidate answer back as a response.
    assert.deepEqual(Object.keys(shadow).sort(), ['candidate', 'eraseSubject', 'eraser', 'flush', 'id', 'isStopped', 'listRuns', 'observe', 'report', 'sampleRate', 'stats']);
  });

  suite('a write tool is never executed, even when the candidate insists; reads are replayed or simulated; nothing else exists in the realm', async (ctx) => {
    await stage(ctx);
    let executed = 0;
    const real = () => { executed++; throw new Error('a real tool was called'); };
    const sandbox = await api.createSandbox({ governor: ctx.governor, organisationId: ORG, tools: {
      send_email: real, // a bare function is conservatively a write
      charge: { kind: 'write', execute: real }, confirm_order: { kind: 'confirm', execute: real },
      lookup: { kind: 'read', execute: real, recordings: [{ input: { id: 1 }, output: { name: 'recorded' } }], response: { name: 'default' } }
    } });
    const agent = async (request, tools) => {
      const written = [await tools.send_email({ to: request.input.email }), await tools.charge({ amount: 10 }), await tools.confirm_order({ id: 1 })];
      const seen = { recorded: await tools.lookup({ id: 1 }), other: await tools.lookup({ id: 2 }) };
      let escaped;
      try { escaped = typeof globalThis.constructor.constructor('return typeof process')(); } catch (_e) { escaped = 'blocked'; }
      return { written, seen, escaped, host: [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer, typeof XMLHttpRequest, typeof WebSocket] };
    };
    const shadow = await api.createShadowRunner({ governor: ctx.governor, organisationId: ORG, candidate: { kind: 'instructions', id: 'main', agent }, sandbox, sampleRate: 1,
      budget: { maxRuns: 10 }, masker: mask, metrics: [{ name: 'accuracy', score: () => true }, { name: 'sources', score: () => true }], target: 'accuracy', store: ctx.stores.shadowStore, now: ctx.clock });
    const ack = await shadow.observe({ request: request(1), stableResult: { output: 1 } }).done;
    assert.equal(ack.status, 'recorded');
    const [run] = await shadow.listRuns();
    assert.equal(executed, 0, 'no real tool function was ever called');
    assert.deepEqual(run.candidate.output.written, [{ simulated: true, intention: true }, { simulated: true, intention: true }, { simulated: true, intention: true }]);
    assert.deepEqual(run.candidate.output.seen, { recorded: { name: 'recorded' }, other: { name: 'default' } });
    assert.deepEqual(run.candidate.output.host, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    assert.notEqual(run.candidate.output.escaped, 'object');
    assert.deepEqual(run.writeIntentions.map((w) => w.tool), ['send_email', 'charge', 'confirm_order']);
    assert.ok(!JSON.stringify(run).includes('alice@example.com'), 'intention inputs are masked');
    assert.deepEqual(run.toolCalls, { read: 2, write: 3 });
    const report = await shadow.report({ minimumSample: 1 });
    assert.deepEqual([report.writeIntentions.total, report.writeIntentions.neverExecuted, report.writeIntentions.byTool.charge], [3, true, 1]);
  });

  suite('per-request recordings replay reads of the stable run; they cannot target a write tool', async (ctx) => {
    await stage(ctx);
    const sandbox = await api.createSandbox({ governor: ctx.governor, organisationId: ORG, tools: { balance: { kind: 'read', response: { value: 'default' } }, pay: { kind: 'write' } } });
    const agent = async (request, tools) => ({ balance: await tools.balance({ account: request.input.account }) });
    const shadow = await runner(ctx, { sandbox, candidate: { kind: 'instructions', id: 'main', agent }, metrics: [{ name: 'accuracy', score: () => true }, { name: 'sources', score: () => true }] });
    const withRecording = { request: { id: 'a', input: { account: 7 } }, stableResult: { output: 0 }, recordings: { balance: [{ input: { account: 7 }, output: { value: 'recorded' } }] } };
    await shadow.observe(withRecording).done;
    await shadow.observe({ request: { id: 'b', input: { account: 8 } }, stableResult: { output: 0 }, recordings: withRecording.recordings }).done;
    const runs = await shadow.listRuns();
    assert.deepEqual(runs.map((r) => r.candidate.output.balance.value).sort(), ['default', 'recorded']);
    const bad = await shadow.observe({ request: { id: 'c', input: 1 }, stableResult: { output: 0 }, recordings: { pay: [{ input: 1, output: 1 }] } }).done;
    assert.deepEqual([bad.status, bad.reason], ['error', 'invalid_input']);
    assert.equal((await shadow.listRuns()).length, 2);
  });

  /* ---------------- the stable answer is never delayed or broken ---------------- */

  suite('observe returns at once and never throws; a failing, slow or hostile candidate delays and breaks nothing', async (ctx) => {
    await stage(ctx);
    const slow = await runner(ctx, { timeoutMs: 5000, candidate: { kind: 'instructions', id: 'main', agent: () => { const end = Date.now() + 400; while (Date.now() < end); return { answer: 1 }; } } });
    const started = Date.now();
    const handle = slow.observe({ request: request(1), stableResult: stableAnswer(1) });
    const returnedAfter = Date.now() - started;
    assert.ok(returnedAfter < 100, `observe took ${returnedAfter} ms`);
    let stableSent = false;
    const respond = async () => { stableSent = true; return 'stable response'; };
    assert.equal(await respond(), 'stable response');
    assert.equal(stableSent, true);
    assert.equal((await handle.done).status, 'recorded', 'the slow run finishes later, on its own');
    assert.ok(Date.now() - started >= 350);

    for (const agent of [() => { throw new Error('boom: Alice Martin'); }, async () => { throw new Error('async boom'); }, () => { for (;;); }, () => 'x'.repeat(2000000),
      () => new Promise(() => {}), () => { throw { toString() { throw new Error('hostile'); } }; }]) {
      const shadow = await runner(ctx, { timeoutMs: 100, candidate: { kind: 'instructions', id: 'main', agent } });
      const result = await shadow.observe({ request: request(1), stableResult: stableAnswer(1) }).done;
      assert.equal(result.status, 'recorded');
      const [run] = await shadow.listRuns();
      assert.notEqual(run.candidate.status, 'completed');
      assert.ok(run.incidents.some((code) => code.startsWith('candidate_')));
      assert.ok(!JSON.stringify(run).includes('boom'), 'the candidate error message is never kept');
      assert.deepEqual(run.scores.accuracy, { candidate: 'failed', stable: 'succeeded' });
      assert.deepEqual(run.stable.output, { answer: 2 });
      await ctx.stores.shadowStore.removeShadowRuns({ organisationId: ORG, userId: 'user-1' });
    }

    const shadow = await runner(ctx);
    for (const garbage of [undefined, null, {}, { request: null }, { request: { id: '' } }, { request: { id: 'x', input: () => 1 }, stableResult: { output: 1 } },
      { request: { id: 'x', input: 1 } }, { request: { id: 'x', input: 1 }, stableResult: { output: 1, cost: -1 } }, { request: { id: 'x', input: new Date() }, stableResult: { output: 1 } },
      (() => { const cyclic = {}; cyclic.self = cyclic; return { request: { id: 'x', input: cyclic }, stableResult: { output: 1 } }; })()]) {
      const handle2 = shadow.observe(garbage);
      assert.equal(handle2.scheduled, false);
      assert.deepEqual([(await handle2.done).status, (await handle2.done).reason], ['rejected', 'invalid_input']);
    }
    assert.equal((await shadow.listRuns()).length, 0);
  });

  suite('a failing store, a failing masker or a metric that throws are isolated: no rejection reaches the caller', async (ctx) => {
    await stage(ctx);
    const broken = { ...ctx.stores.shadowStore, putShadowRun: async () => { throw new Error('disk full'); } };
    const withBrokenStore = await runner(ctx, { store: broken });
    const result = await withBrokenStore.observe({ request: request(1), stableResult: stableAnswer(1) }).done;
    assert.equal(result.status, 'error');
    assert.equal(withBrokenStore.stats().recorded, 0);
    // The masker is the privacy guard: if it fails, nothing is stored.
    const badMasker = await runner(ctx, { masker: () => { throw new Error('masker down'); } });
    assert.equal((await badMasker.observe({ request: request(2), stableResult: stableAnswer(2) }).done).status, 'error');
    const wrongMasker = await runner(ctx, { masker: () => 42 });
    assert.deepEqual(await wrongMasker.observe({ request: request(3), stableResult: stableAnswer(3) }).done, { status: 'error', reason: 'masker_invalid' });
    assert.equal((await ctx.stores.shadowStore.listShadowRuns({ organisationId: ORG })).length, 0);
    // A metric that throws or answers badly makes that score unknown, and says so.
    const flaky = await runner(ctx, { metrics: [{ name: 'accuracy', score: () => { throw new Error('metric bug'); } }, { name: 'sources', score: () => 'yes' }] });
    assert.equal((await flaky.observe({ request: request(4), stableResult: stableAnswer(4) }).done).status, 'recorded');
    const [run] = await flaky.listRuns();
    assert.deepEqual(run.scores.accuracy, { candidate: 'unknown', stable: 'unknown' });
    assert.deepEqual(run.incidents, ['scoring_failed', 'scoring_invalid']);
  });

  suite('a stalled pipeline is abandoned after the deadline and writes nothing', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx, { deadlineMs: 50, masker: () => new Promise(() => {}) });
    const started = Date.now();
    const result = await shadow.observe({ request: request(1), stableResult: stableAnswer(1) }).done;
    assert.deepEqual(result, { status: 'timeout', reason: 'deadline' });
    assert.ok(Date.now() - started < 1500);
    assert.equal((await ctx.stores.shadowStore.listShadowRuns({ organisationId: ORG })).length, 0);
    assert.equal(shadow.stats().inflight, 0);
  });

  suite('concurrency is capped: a burst beyond the limit is skipped as busy, never queued behind the stable path', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx, { maxConcurrent: 2, candidate: { kind: 'instructions', id: 'main', agent: () => { const end = Date.now() + 80; while (Date.now() < end); return { answer: 2 }; } } });
    const handles = Array.from({ length: 6 }, (_, i) => shadow.observe({ request: request(i + 1), stableResult: stableAnswer(i + 1) }));
    assert.equal(handles.filter((h) => h.scheduled).length, 2);
    assert.deepEqual(handles.filter((h) => !h.scheduled).map((h) => h.reason), ['busy', 'busy', 'busy', 'busy']);
    await shadow.flush();
    assert.equal(shadow.stats().skipped.busy, 4);
  });

  suite('the same request is recorded once, even observed twice or at the same time', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx);
    const same = { request: request(5), stableResult: stableAnswer(5) };
    const [a, b] = [shadow.observe(same), shadow.observe(same)];
    assert.deepEqual([a.scheduled, b.scheduled, b.reason], [true, false, 'duplicate']);
    await a.done;
    const again = await shadow.observe(same).done;
    assert.deepEqual([again.status, again.reason], ['skipped', 'duplicate']);
    assert.equal((await shadow.listRuns()).length, 1);
    // Another runner on the same store continues the same shadow and does not repeat it.
    const other = await runner(ctx);
    assert.equal(other.id, shadow.id);
    assert.equal((await other.observe(same).done).reason, 'duplicate');
  });

  /* ---------------- sampling, budget, kill switch ---------------- */

  suite('sampling is deterministic, proportional and nested; the request id decides, not the order', async (ctx) => {
    await stage(ctx);
    const pick = async (sampleRate, ids) => {
      const shadow = await runner(ctx, { sampleRate, maxConcurrent: 64, store: api.createMemoryShadowStore(), candidate: { kind: 'instructions', id: 'main', agent: () => 1 } });
      const chosen = [];
      for (const id of ids) { const handle = shadow.observe({ request: { id, input: 1 }, stableResult: { output: 1 } }); if (handle.scheduled) chosen.push(id); await handle.done; }
      return chosen;
    };
    const ids = Array.from({ length: 240 }, (_, i) => `r${i}`);
    const half = await pick(0.5, ids), again = await pick(0.5, ids), reversed = await pick(0.5, [...ids].reverse());
    assert.deepEqual(half, again);
    assert.deepEqual([...reversed].sort(), [...half].sort());
    assert.ok(half.length > 85 && half.length < 155, `about half, got ${half.length}`);
    const tenth = await pick(0.1, ids);
    assert.ok(tenth.length > 8 && tenth.length < 45, `about a tenth, got ${tenth.length}`);
    assert.ok(tenth.every((id) => half.includes(id)), 'a lower rate selects a subset of a higher one');
    assert.equal((await pick(1, ids.slice(0, 20))).length, 20);
    const stats = (await runner(ctx, { sampleRate: 0.5 })).stats();
    assert.equal(stats.seen, 0);
  });

  suite('the budget is capped: when spent, the shadow stops and stays stopped, also after a restart', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx, { budget: { maxRuns: 3 } });
    const results = await feed(shadow, items(6));
    assert.deepEqual(results.map((r) => r.status), ['recorded', 'recorded', 'recorded', 'skipped', 'skipped', 'skipped']);
    assert.equal(results[3].reason, 'budget_exhausted');
    assert.equal(shadow.isStopped(), true);
    assert.equal(shadow.stats().stopped.reason, 'budget_exhausted');
    assert.equal(shadow.observe({ request: request(99), stableResult: stableAnswer(9) }).scheduled, false);
    assert.equal((await shadow.listRuns()).length, 3);
    const restarted = await runner(ctx, { budget: { maxRuns: 3 } });
    assert.equal((await restarted.observe({ request: request(50), stableResult: stableAnswer(50) }).done).reason, 'budget_exhausted');
    // A larger budget lets the same shadow go on; the earlier runs are counted.
    const bigger = await runner(ctx, { budget: { maxRuns: 4 } });
    assert.equal((await bigger.observe({ request: request(51), stableResult: stableAnswer(51) }).done).status, 'recorded');
    assert.equal((await bigger.observe({ request: request(52), stableResult: stableAnswer(52) }).done).reason, 'budget_exhausted');

    // Cost cap: a run costs what the application says (costOf), a fixed amount otherwise.
    const costly = await runner(ctx, { store: api.createMemoryShadowStore(), budget: { maxCost: 5, costPerRun: 2 } });
    assert.deepEqual((await feed(costly, items(4))).map((r) => r.status), ['recorded', 'recorded', 'skipped', 'skipped']);
    // costPerRun is the ceiling reserved for one run; the measured cost can only be lower, which leaves room for more runs.
    const metered = await runner(ctx, { store: api.createMemoryShadowStore(), budget: { maxCost: 5, costPerRun: 3, costOf: ({ durationMs }) => (durationMs >= 0 ? 2 : 0) } });
    assert.deepEqual((await feed(metered, items(4))).map((r) => r.status), ['recorded', 'recorded', 'skipped', 'skipped']);
    const [run] = await metered.listRuns();
    assert.equal(run.cost, 2);
    const over = await runner(ctx, { store: api.createMemoryShadowStore(), budget: { maxCost: 100, costPerRun: 1, costOf: () => 9 } });
    await feed(over, items(1));
    const [overRun] = await over.listRuns();
    assert.deepEqual([overRun.cost, overRun.incidents], [1, ['cost_over_ceiling']]);
    // Concurrent runs never exceed the cap.
    const parallel = await runner(ctx, { store: api.createMemoryShadowStore(), maxConcurrent: 16, budget: { maxRuns: 3 } });
    await Promise.all(items(10).map((item) => parallel.observe(item).done));
    assert.equal((await parallel.listRuns()).length, 3);
    // The time cap stops the shadow once the measured time is used up.
    const timed = await runner(ctx, { store: api.createMemoryShadowStore(), budget: { maxDurationMs: 60 }, candidate: { kind: 'instructions', id: 'main', agent: () => { const end = Date.now() + 40; while (Date.now() < end); return { answer: 2 }; } } });
    const timedResults = await feed(timed, items(6));
    assert.equal(timedResults[0].status, 'recorded');
    assert.equal(timedResults.at(-1).reason, 'budget_exhausted');
    assert.ok((await timed.listRuns()).length <= 3);
  });

  suite('the governor budget applies too: an agent spend refused by the governor stops the shadow', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx, { budget: { maxRuns: 100, governorAgentId: 'shadow-agent' } });
    const results = await feed(shadow, items(8));
    // perCycle is 5 in the test policy.
    assert.deepEqual(results.map((r) => r.status), ['recorded', 'recorded', 'recorded', 'recorded', 'recorded', 'skipped', 'skipped', 'skipped']);
    assert.equal(results[5].reason, 'governor_budget');
    assert.equal(shadow.isStopped(), true);
    assert.equal((await shadow.listRuns()).length, 5);
    assert.ok((await ctx.governor.listAudit({ organisationId: ORG, actions: ['spend_refused'] })).length >= 1);
  });

  suite('the kill switch stops everything at once: no run, no report, no restart; a run in flight is dropped', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx, { timeoutMs: 5000, candidate: { kind: 'instructions', id: 'main', agent: () => { const end = Date.now() + 250; while (Date.now() < end); return { answer: 2 }; } } });
    await feed(shadow, items(2));
    assert.equal((await shadow.listRuns()).length, 2);
    // A run is in flight while a human pulls the switch.
    const inFlight = shadow.observe({ request: request(10), stableResult: stableAnswer(10) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await ctx.governor.halt({ organisationId: ORG, by: human('boss'), reason: 'incident' });
    const outcome = await inFlight.done;
    assert.deepEqual([outcome.status, outcome.reason], ['skipped', 'governor_halted']);
    assert.equal((await ctx.stores.shadowStore.listShadowRuns({ organisationId: ORG })).length, 2, 'the run finished after the stop was dropped');
    // Later requests are refused straight away, with no work and no waiting.
    const after = shadow.observe({ request: request(11), stableResult: stableAnswer(11) });
    assert.deepEqual([after.scheduled, after.reason], [false, 'governor_halted']);
    assert.equal(shadow.isStopped(), true);
    await assert.rejects(shadow.report(), { code: 'governor_halted' });
    await assert.rejects(shadow.listRuns(), { code: 'governor_halted' });
    await assert.rejects(runner(ctx), { code: 'governor_halted' });
    // Releasing the switch does not wake this shadow: a human starts a new one.
    await ctx.governor.resume({ organisationId: ORG, by: human('boss') });
    assert.equal(shadow.observe({ request: request(12), stableResult: stableAnswer(12) }).scheduled, false);
    // The emergency stop brought the candidate back to stable: a new shadow has nothing to run.
    await assert.rejects(runner(ctx), { code: 'candidate_not_staged' });
  });

  suite('a shadow stops when its candidate is rolled back, promoted or replaced', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx);
    assert.equal((await shadow.observe({ request: request(1), stableResult: stableAnswer(1) }).done).status, 'recorded');
    await ctx.governor.rollbackChange({ organisationId: ORG, kind: 'instructions', id: 'main', by: human('boss'), reason: 'changed my mind' });
    const result = await shadow.observe({ request: request(2), stableResult: stableAnswer(2) }).done;
    assert.deepEqual([result.status, result.reason], ['skipped', 'candidate_unavailable']);
    assert.equal(shadow.isStopped(), true);
    assert.equal((await shadow.listRuns()).length, 1);
  });

  /* ---------------- the report ---------------- */

  suite('report: below the minimum sample it refuses to conclude, with honest intervals', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx);
    await feed(shadow, items(12));
    const report = await shadow.report();
    assert.equal(report.conclusion, 'insufficient_data');
    assert.ok(report.reasons.includes('below_minimum_sample'));
    assert.equal(report.sample.runs, 12);
    assert.equal(report.sample.status, 'insufficient_data');
    for (const name of ['accuracy', 'sources']) {
      assert.equal(report.metrics[name].status, 'insufficient_data');
      assert.equal(report.metrics[name].difference, null);
      assert.equal(report.metrics[name].candidate.conclusion, 'refuse_to_conclude');
      assert.ok(report.metrics[name].candidate.interval.low < report.metrics[name].candidate.rate);
    }
    assert.equal(report.antiGoodhart, null);
    assert.equal((await shadow.report({ minimumSample: 10 })).sample.status, 'observed');
    assert.equal(api.SHADOW_CONCLUSIONS.join(), 'insufficient_data,regression,no_difference,promising');
    const empty = await (await runner(ctx, { store: api.createMemoryShadowStore() })).report();
    assert.deepEqual([empty.conclusion, empty.sample.runs], ['insufficient_data', 0]);
  });

  suite('report: a clear gain with every counter-measure held is "promising", never proven; it only feeds a proposal', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx, { minimumSample: 30 });
    // Stable is right 3 times out of 4; the candidate is always right; "sources" is the same for both.
    await feed(shadow, items(80));
    const report = await shadow.report();
    assert.equal(report.conclusion, 'promising');
    assert.deepEqual(report.reasons, ['target_improved_counter_measures_held']);
    assert.ok(report.metrics.accuracy.difference.low > 0 && report.metrics.accuracy.difference.difference > 0.2);
    assert.equal(report.metrics.accuracy.paired.onlyCandidateSucceeded, 20);
    assert.equal(report.antiGoodhart.status, 'accepted');
    assert.deepEqual([report.provesImprovement, report.causality, report.applied, report.proposal], [false, 'not_established', false, null]);
    assert.ok(!/\bproven\b|\bproved\b/i.test(JSON.stringify(report).replace(/provesImprovement/g, '')));
    assert.equal(report.agreement.rate, 0.75);
    assert.equal(report.incidents.runs, 0);

    const before = await ctx.governor.getObject({ organisationId: ORG, kind: 'instructions', id: 'main' });
    const fed = await shadow.report({ propose: { proposedBy: engine, owner: 'ops' }, recordedBy: { kind: 'system', id: 'shadow' } });
    assert.equal(fed.proposal.status, 'pending_approval');
    assert.equal(fed.proposal.target.kind, 'instructions');
    assert.equal(fed.proposal.change.shadowEvidence.conclusion, 'promising');
    assert.equal(fed.finding.code, 'shadow_promising');
    // Nothing moved: same stable version, same candidate, still 0 % exposure, no deploy or promote in the audit trail.
    const after = await ctx.governor.getObject({ organisationId: ORG, kind: 'instructions', id: 'main' });
    assert.deepEqual([after.stable, after.candidate, after.rollout.percentage, after.revision], [before.stable, before.candidate, 0, before.revision]);
    const audit = await ctx.governor.listAudit({ organisationId: ORG });
    assert.equal(audit.filter((e) => ['deploy', 'promote'].includes(e.action)).length, 0);
    // The proposal waits for a human, like any other; the same report does not duplicate it.
    assert.equal((await shadow.report({ propose: { proposedBy: engine, owner: 'ops' } })).proposal.id, fed.proposal.id);
    await assert.rejects(ctx.governor.approveProposal(fed.proposal.id, { approver: { kind: 'model', id: 'judge' }, organisationId: ORG }), { code: 'approver_not_human' });
  });

  suite('report: no difference, and a conclusion only when a proposal is requested for a promising one', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx);
    await feed(shadow, items(60, (i) => stableAnswer(i, true)));
    const report = await shadow.report({ propose: { proposedBy: engine }, recordedBy: { kind: 'system', id: 'shadow' } });
    assert.equal(report.conclusion, 'no_difference');
    assert.equal(report.proposal, null, 'no proposal for anything but a promising result');
    assert.equal(report.finding.code, 'shadow_no_difference');
    assert.equal((await ctx.governor.listProposals({ organisationId: ORG })).filter((p) => p.target.id.startsWith('shadow:')).length, 0);
    assert.equal(report.metrics.accuracy.difference.difference, 0);
    assert.equal(report.agreement.rate, 1);
  });

  suite('report: a significantly worse candidate is a regression, listed with its cause', async (ctx) => {
    await stage(ctx);
    const worse = await runner(ctx, { candidate: { kind: 'instructions', id: 'main', agent: async (r) => ({ answer: r.input.n % 2 ? r.input.n * 2 : -1 }) } });
    await feed(worse, items(80, (i) => stableAnswer(i, true)));
    const report = await worse.report({ recordedBy: { kind: 'system', id: 'shadow' } });
    assert.equal(report.conclusion, 'regression');
    assert.ok(report.reasons.includes('significant_decline:accuracy'));
    assert.ok(report.metrics.accuracy.difference.high < 0);
    assert.ok(report.metrics.accuracy.paired.onlyStableSucceeded >= 40);
    assert.equal(report.finding.severity, 'high');
    assert.equal(report.proposal, null);
    // A candidate that crashes often is a regression too, whatever its metrics say.
    const crashing = await runner(ctx, { store: api.createMemoryShadowStore(), metrics: [{ name: 'accuracy', score: () => true }, { name: 'sources', score: () => true }],
      candidate: { kind: 'instructions', id: 'main', agent: async (r) => { if (r.input.n % 2) throw new Error('crash'); return { answer: r.input.n * 2 }; } } });
    await feed(crashing, items(60, (i) => stableAnswer(i, true)));
    const crashes = await crashing.report();
    assert.equal(crashes.conclusion, 'regression');
    assert.ok(crashes.reasons.includes('candidate_incidents'));
    assert.equal(crashes.incidents.byCode.candidate_failed, 30);
  });

  suite('report: one critical regression is enough, even far below the minimum sample, and the case is listed masked', async (ctx) => {
    await stage(ctx);
    const critical = [{ name: 'accuracy', score: metrics[0].score }, { name: 'minor_protection', critical: true, score: ({ input, output }) => !(input.minor && output.answer === -1) }];
    const shadow = await runner(ctx, { metrics: critical, candidate: { kind: 'instructions', id: 'main', agent: async (r) => ({ answer: r.input.minor ? -1 : r.input.n * 2 }) } });
    await feed(shadow, [
      { request: request(1), stableResult: stableAnswer(1, true) },
      { request: { ...request(2), input: { n: 2, minor: true, email: 'alice@example.com', note: 'Alice Martin asked' } }, stableResult: { output: { answer: 4 } } }
    ]);
    const report = await shadow.report();
    assert.equal(report.sample.runs, 2);
    assert.equal(report.conclusion, 'regression');
    assert.deepEqual(report.reasons, ['critical_regression']);
    assert.equal(report.criticalRegressions.length, 1);
    const [case1] = report.criticalRegressions;
    assert.equal(case1.metric, 'minor_protection');
    assert.deepEqual(case1.stableOutput, { answer: 4 });
    assert.ok(!JSON.stringify(report).includes('alice@example.com') && !JSON.stringify(report).includes('Alice Martin'));
    // Allowing one by configuration is possible, and explicit.
    const tolerant = await runner(ctx, { store: api.createMemoryShadowStore(), metrics: critical, maxCriticalRegressions: 1, candidate: { kind: 'instructions', id: 'main', agent: async (r) => ({ answer: r.input.minor ? -1 : r.input.n * 2 }) } });
    await feed(tolerant, [{ request: { id: 'm', input: { n: 2, minor: true } }, stableResult: { output: { answer: 4 } } }]);
    assert.notEqual((await tolerant.report()).conclusion, 'regression');
  });

  suite('report: anti-Goodhart — a better target bought with a worse counter-measure is rejected', async (ctx) => {
    await stage(ctx);
    const cheating = [
      { name: 'thumbs_up', score: ({ output }) => output.liked === true },
      { name: 'sources_accuracy', maxRegression: 0.05, score: ({ output }) => output.sourced === true }
    ];
    const stable = (i) => ({ output: { liked: i % 3 === 0, sourced: true } });
    const flattering = await runner(ctx, { metrics: cheating, target: 'thumbs_up', candidate: { kind: 'instructions', id: 'main', agent: async (r) => ({ liked: true, sourced: r.input.n % 2 === 0 }) } });
    await feed(flattering, items(90, stable));
    const report = await flattering.report();
    assert.ok(report.metrics.thumbs_up.difference.low > 0, 'the target clearly improved');
    assert.equal(report.antiGoodhart.status, 'rejected');
    assert.equal(report.antiGoodhart.violations[0].name, 'sources_accuracy');
    assert.equal(report.conclusion, 'regression');
    assert.ok(report.reasons.includes('counter_measure_regressed:sources_accuracy'));
    assert.notEqual(report.conclusion, 'promising');
    // The same gain with the counter-measure held is promising.
    const honest = await runner(ctx, { store: api.createMemoryShadowStore(), metrics: cheating, target: 'thumbs_up', candidate: { kind: 'instructions', id: 'main', agent: async () => ({ liked: true, sourced: true }) } });
    await feed(honest, items(90, stable));
    assert.equal((await honest.report()).conclusion, 'promising');
    // Cost is a counter-measure too: a gain that doubles the cost beyond the limit is rejected.
    const pricey = await runner(ctx, { store: api.createMemoryShadowStore(), metrics: cheating, target: 'thumbs_up', limits: { cost: 0.5 }, budget: { maxRuns: 1000, costPerRun: 3, costOf: () => 3 },
      candidate: { kind: 'instructions', id: 'main', agent: async () => ({ liked: true, sourced: true }) } });
    await feed(pricey, items(90, (i) => ({ output: { liked: i % 3 === 0, sourced: true }, cost: 1 })));
    const expensive = await pricey.report();
    assert.equal(expensive.conclusion, 'regression');
    assert.ok(expensive.reasons.includes('counter_measure_regressed:cost'));
    // Cost limit without the stable cost: the comparison cannot be made, so no conclusion.
    const unmeasured = await runner(ctx, { store: api.createMemoryShadowStore(), metrics: cheating, target: 'thumbs_up', limits: { cost: 0.5 },
      candidate: { kind: 'instructions', id: 'main', agent: async () => ({ liked: true, sourced: true }) } });
    await feed(unmeasured, items(60, (i) => ({ output: { liked: i % 3 === 0, sourced: true } })));
    const blind = await unmeasured.report();
    assert.equal(blind.conclusion, 'insufficient_data');
    assert.ok(blind.reasons.includes('cost_unmeasured'));
  });

  suite('report: unknown scores are excluded, never counted as success', async (ctx) => {
    await stage(ctx);
    const partial = [{ name: 'accuracy', score: ({ input, output }) => (input.n % 2 ? output.answer === input.n * 2 : null) }, metrics[1]];
    const shadow = await runner(ctx, { metrics: partial });
    await feed(shadow, items(40, (i) => stableAnswer(i, true)));
    const report = await shadow.report({ minimumSample: 10 });
    assert.deepEqual([report.metrics.accuracy.candidate.sampleSize, report.metrics.accuracy.candidate.unknown], [20, 20]);
    assert.equal(report.metrics.accuracy.paired.unknown, 20);
    const strict = await shadow.report({ minimumSample: 30 });
    assert.equal(strict.metrics.accuracy.status, 'insufficient_data');
    assert.equal(strict.conclusion, 'insufficient_data');
  });

  /* ---------------- privacy, isolation, erasure ---------------- */

  suite('everything stored is masked; the metrics and the candidate see the real request, the store never does', async (ctx) => {
    await stage(ctx);
    const seen = [];
    const spy = [{ name: 'accuracy', score: ({ input, output }) => { seen.push(input.email); return output.answer === input.n * 2; } }, metrics[1]];
    const shadow = await runner(ctx, { metrics: spy, candidate: { kind: 'instructions', id: 'main', agent: async (r) => ({ answer: r.input.n * 2, echo: r.input.email, who: r.input.note }) } });
    await feed(shadow, items(3));
    assert.ok(seen.length >= 3 && seen.every((email) => email === 'alice@example.com'));
    const dump = JSON.stringify(await ctx.stores.shadowStore.listShadowRuns({ organisationId: ORG }));
    for (const secret of PEOPLE) assert.ok(!dump.includes(secret), `${secret} leaked`);
    assert.ok(dump.includes('[EMAIL]') && dump.includes('[PERSON]'));
    const [run] = await shadow.listRuns();
    assert.equal(run.request.input.email, '[EMAIL]');
    assert.equal(run.candidate.output.echo, '[EMAIL]');
    assert.ok(!('requestId' in run) && !JSON.stringify(run).includes('req-1'), 'the raw request id is not kept');
    // Oversized outputs are replaced by a fingerprint rather than stored.
    const big = await runner(ctx, { store: api.createMemoryShadowStore(), candidate: { kind: 'instructions', id: 'main', agent: () => ({ answer: 'x'.repeat(30000) }) } });
    await big.observe({ request: request(1), stableResult: stableAnswer(1) }).done;
    const [bigRun] = await big.listRuns();
    assert.equal(bigRun.candidate.output.truncated, true);
    assert.match(bigRun.candidate.output.fingerprint, /^[0-9a-f]{64}$/);
  });

  suite('organisations are isolated: reports, runs, budgets, erasure and sandboxes never cross', async (ctx) => {
    await stage(ctx);
    await stage(ctx, { organisationId: 'org-b' });
    const a = await runner(ctx, { budget: { maxRuns: 2 } });
    const b = await runner(ctx, { organisationId: 'org-b', budget: { maxRuns: 5 } });
    await feed(a, items(5));
    await feed(b, items(4));
    assert.equal((await a.listRuns()).length, 2);
    assert.equal((await b.listRuns()).length, 4);
    assert.ok((await a.listRuns()).every((r) => r.organisationId === ORG));
    assert.ok((await b.listRuns()).every((r) => r.organisationId === 'org-b'));
    assert.equal((await b.report({ minimumSample: 1 })).sample.runs, 4);
    // Same person id, same request ids, different organisations: separate rows.
    assert.equal((await ctx.stores.shadowStore.listShadowRuns({ organisationId: ORG, userId: 'user-1' })).length, 2);
    assert.deepEqual(await a.eraseSubject({ organisationId: ORG, userId: 'user-1' }), { removed: 2 });
    assert.equal((await b.listRuns()).length, 4, 'the other organisation keeps its runs');
    await assert.rejects(a.eraseSubject({ organisationId: 'org-b', userId: 'user-1' }), { code: 'cross_organisation' });
    await assert.rejects(a.eraseSubject({ organisationId: ORG }), { code: 'invalid_input' });
    assert.equal(await ctx.stores.shadowStore.getShadowRun(ORG, (await b.listRuns())[0].id), null);
    // A shadow of another organisation's object, or with its sandbox, is refused.
    await assert.rejects(api.createShadowRunner({ governor: ctx.governor, organisationId: ORG, candidate: { kind: 'instructions', id: 'main', agent: doubling }, sandbox: await sandboxOf(ctx, {}, 'org-b'),
      sampleRate: 1, budget: { maxRuns: 1 }, masker: mask, metrics, target: 'accuracy' }), { code: 'cross_organisation' });
  });

  suite('erasing a person erases their shadow runs, through the conscience as through the shadow', async (ctx) => {
    await stage(ctx);
    const shadow = await runner(ctx);
    await feed(shadow, [
      { request: request(1, { userId: 'user-1' }), stableResult: stableAnswer(1) },
      { request: request(2, { userId: 'user-1' }), stableResult: stableAnswer(2) },
      { request: request(3, { userId: 'user-2' }), stableResult: stableAnswer(3) },
      { request: request(4, { userId: null }), stableResult: stableAnswer(4) }
    ]);
    assert.equal((await shadow.listRuns()).length, 4);
    const report = await ctx.conscience.eraseSubject({ organisationId: ORG, userId: 'user-1' });
    assert.deepEqual(report.extensions.find((e) => e.name === 'shadow_runs'), { name: 'shadow_runs', count: 2 });
    assert.deepEqual((await shadow.listRuns()).map((r) => r.userId).sort(), [null, 'user-2']);
    assert.equal((await shadow.report({ minimumSample: 1 })).sample.runs, 2);
    assert.deepEqual(await shadow.eraseSubject({ organisationId: ORG, userId: 'user-2' }), { removed: 1 });
    assert.deepEqual(await shadow.eraseSubject({ organisationId: ORG, userId: 'user-2' }), { removed: 0 });
    assert.equal((await shadow.listRuns()).length, 1);
    assert.throws(() => api.shadowEraser({}), { code: 'store_invalid' });
  });

  suite('a candidate may hold an injected model call: it runs as a sandbox tool, replayed or simulated, never over the network', async (ctx) => {
    await stage(ctx);
    const sandbox = await api.createSandbox({ governor: ctx.governor, organisationId: ORG, tools: { model: { kind: 'read', recordings: [{ input: { prompt: 'say hi' }, output: { text: 'hi' } }], response: { text: 'unknown' } } } });
    const agent = async (r, tools) => ({ answer: (await tools.model({ prompt: r.input.prompt })).text });
    const shadow = await runner(ctx, { sandbox, candidate: { kind: 'instructions', id: 'main', agent }, metrics: [{ name: 'accuracy', score: ({ output }) => output.answer === 'hi' }, { name: 'sources', score: () => true }] });
    await shadow.observe({ request: { id: 'a', input: { prompt: 'say hi' } }, stableResult: { output: { answer: 'hi' } } }).done;
    await shadow.observe({ request: { id: 'b', input: { prompt: 'other' } }, stableResult: { output: { answer: 'hi' } } }).done;
    const runs = await shadow.listRuns();
    assert.deepEqual(runs.map((r) => r.candidate.output.answer).sort(), ['hi', 'unknown']);
    assert.deepEqual(runs.map((r) => r.scores.accuracy.candidate).sort(), ['failed', 'succeeded']);
  });
}

module.exports = { shadowContract };
