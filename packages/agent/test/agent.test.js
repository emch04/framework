'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAgent, createMemoryTaskStore } = require('../src');
const { tool, call } = require('./helpers');
test('executes beyond six turns, checkpoints tools, and reports usage', async () => {
  let turns = 0; let runs = 0; const events = [];
  const agent = createAgent({ tools: [tool('lookup', async () => { runs++; return { data: 'ok' }; })], turn: () => ++turns <= 12 ? { toolCalls: [call('lookup', `c${turns}`)], usage: { inputTokens: 2, outputTokens: 1 } } : { text: 'Complete', usage: { inputTokens: 2, outputTokens: 1 } }, onEvent: event => events.push(event), verify: () => true });
  const result = await agent.run({ question: 'Work' });
  assert.equal(result.state, 'completed'); assert.equal(runs, 12); assert.equal(result.turns, 13);
  assert.equal(result.usage.inputTokens, 26); assert.equal(result.steps.length, 12);
  assert.equal(result.messages.filter(message => message.toolCalls).length, 12);
  assert.equal(events.filter(event => event.type === 'usage').length, 13);
  assert.equal((await agent.resume(result.id)).turns, 13);
});
for (const [budget, reason] of [[{ maxTurns: 1 }, 'turns'], [{ maxTokens: 1 }, 'tokens'], [{ maxCost: 0.01 }, 'cost'], [{ maxMs: 0 }, 'time']]) test(`budget ${reason} produces bounded final response`, async () => {
  const requests = [];
  const agent = createAgent({ budget, tools: [tool()], turn: request => { requests.push(request); return request.phase === 'final' ? { text: 'Remaining work' } : { toolCalls: [call()], usage: { inputTokens: 10, outputTokens: 10, cost: 1 } }; } });
  const result = await agent.run({ question: 'Work' });
  assert.equal(result.stopReason, reason); assert.equal(result.text, 'Remaining work'); assert.equal(result.state, 'failed');
  assert.equal(requests.at(-1).tools.length, 0); assert.equal(result.usageHistory.at(-1).phase, 'final');
});
test('verification resumes until complete and enforces retry maximum', async () => {
  let count = 0;
  const agent = createAgent({ turn: () => ({ text: 'Candidate' }), verify: () => ({ complete: ++count === 3, feedback: 'More work' }) });
  const result = await agent.run({ question: 'Work' });
  assert.equal(result.verified, true); assert.equal(result.verificationRetries, 2);
  const failed = await createAgent({ turn: () => ({ text: 'Candidate' }), verify: () => false, maxVerificationRetries: 1 }).run({ question: 'Work' });
  assert.equal(failed.state, 'failed'); assert.equal(failed.turns, 2); assert.equal(failed.stopReason, 'verification');
});
test('model verification and summary have no tools and contribute usage', async () => {
  const phases = [];
  const agent = createAgent({ contextSummary: { maxChars: 1, keepLast: 1 }, verificationInstruction: 'Check completion.', turn: request => {
    phases.push(request.phase);
    if (request.phase !== 'execution') assert.deepEqual(request.tools, []);
    return { text: request.phase === 'verification' ? '{"complete":true}' : request.phase === 'summary' ? 'Previous work' : 'Complete', usage: { inputTokens: 1, outputTokens: 1 } };
  } });
  const result = await agent.run({ question: 'Work', messages: [{ role: 'user', text: 'Old context' }] });
  assert.deepEqual(phases, ['summary', 'execution', 'verification']); assert.equal(result.usage.inputTokens, 3);
  assert.match(result.messages[0].text, /Context summary/);
});
test('plan changes are durable and exposed to the next model turn', async () => {
  let count = 0; const events = [];
  const agent = createAgent({ onEvent: event => events.push(event), turn: request => {
    if (++count === 1) return { toolCalls: [call('update_plan', 'p', { steps: [{ id: 'a', text: 'Calculate', state: 'done' }] })] };
    // The plan is also visible through the tool result within a single loop.
    assert.ok(JSON.stringify(request.messages).includes('Calculate')); assert.match(request.system, /Calculate/); return { text: 'Done' };
  } });
  const result = await agent.run({ question: 'Work' });
  assert.equal(result.plan[0].state, 'done'); assert.equal(events.filter(event => event.type === 'plan').length, 1);
});
test('confirmation resumes a saved group without repeating completed tools', async () => {
  let reads = 0; let writes = 0; let turns = 0; const store = createMemoryTaskStore();
  const tools = [tool('lookup', async () => { reads++; return { data: 'ok' }; }), { ...tool('change'), kind: 'confirm', perform: async (_args, context) => { assert.ok(context.idempotencyKey); writes++; return { data: 'changed' }; } }];
  const turn = () => ++turns === 1 ? { toolCalls: [call('lookup', 'r'), call('change', 'w')] } : { text: 'Done' };
  const first = createAgent({ store, tools, turn }); const waiting = await first.run({ question: 'Work' });
  assert.equal(waiting.state, 'waiting_confirmation'); assert.equal(reads, 1); assert.equal(writes, 0);
  const next = createAgent({ store, tools, turn }); assert.equal((await next.resume(waiting.id)).state, 'waiting_confirmation');
  const result = await next.resume(waiting.id, { confirmation: { key: waiting.confirmation.key, approved: true } });
  assert.equal(result.state, 'completed'); assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(result.steps.length, 2);
});
test('rejected confirmation never performs the tool', async () => {
  let turns = 0;
  const agent = createAgent({ tools: [{ ...tool(), kind: 'confirm', perform: () => { throw new Error('Unexpected write'); } }], turn: () => ++turns === 1 ? { toolCalls: [call()] } : { text: 'Rejected' } });
  const waiting = await agent.run({ question: 'Work' });
  const result = await agent.resume(waiting.id, { confirmation: { key: waiting.confirmation.key, approved: false } });
  assert.equal(result.steps[0].result.result.status, 'rejected');
});
test('locks exclude concurrent runs and renew during slow model requests', async () => {
  let resolve; const blocked = new Promise(done => { resolve = done; });
  const store = createMemoryTaskStore(); const agent = createAgent({ store, leaseMs: 30, turn: async () => { await blocked; return { text: 'Done' }; } });
  const task = await agent.create({ question: 'Work' }); const running = agent.resume(task.id);
  await new Promise(done => setTimeout(done, 80));
  await assert.rejects(agent.resume(task.id), /locked/); resolve(); await running;
});
test('abort interrupts a non-cooperative model and persists cancellation', async () => {
  const controller = new globalThis.AbortController();
  const agent = createAgent({ turn: () => new Promise(() => {}) }); const task = await agent.create({ question: 'Work' });
  const running = agent.resume(task.id, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Cancelled')), 10);
  await assert.rejects(running, /Cancelled/); assert.equal((await agent.store.get(task.id)).state, 'cancelled');
});
test('time budget interrupts a blocked model, and final reserve has its own timeout', async () => {
  const result = await createAgent({ budget: { maxMs: 10 }, turn: request => request.phase === 'final' ? { text: 'Time exhausted' } : new Promise(() => {}) }).run({ question: 'Work' });
  assert.equal(result.stopReason, 'time');
  await assert.rejects(createAgent({ budget: { maxTurns: 0 }, finalMs: 10, turn: () => new Promise(() => {}) }).run({ question: 'Work' }), /timed out/);
});
test('invalid configuration and malformed verification fail explicitly', async () => {
  for (const options of [{}, { turn() {}, leaseMs: 0 }, { turn() {}, maxVerificationRetries: -1 }, { turn() {}, tools: [tool('update_plan')] }]) assert.throws(() => createAgent(options));
  const agent = createAgent({ turn: () => ({ text: 'Done' }), verify: () => ({}) });
  await assert.rejects(agent.run({ id: 'invalid', question: 'Work' }), /Verification/);
  assert.equal((await agent.store.get('invalid')).state, 'failed');
  await assert.rejects(agent.create({ question: '' }), /question/);
});
test('failed model request resumes persisted tool results with a fresh runner', async () => {
  let runs = 0; let turns = 0; const store = createMemoryTaskStore();
  const tools = [tool('lookup', async () => { runs++; return { data: 'saved' }; })];
  const first = createAgent({ store, tools, turn: () => { if (++turns === 1) return { toolCalls: [call()] }; throw new Error('Disconnected'); } });
  await assert.rejects(first.run({ id: 'resume', question: 'Work' }), /Disconnected/);
  const next = createAgent({ store, tools, turn: ({ messages }) => { assert.equal(messages.at(-1).result, 'saved'); return { text: 'Done' }; } });
  const result = await next.resume('resume'); assert.equal(result.state, 'completed'); assert.equal(runs, 1); assert.equal(result.turns, 3);
});
test('injected summarizer is persisted and abortable', async () => {
  const events = [];
  const result = await createAgent({ contextSummary: { maxTokens: 1, keepLast: 1 }, summarize: ({ plan }) => { assert.deepEqual(plan, []); return 'Summary'; }, turn: () => ({ text: 'Done' }), onEvent: event => events.push(event) }).run({ question: 'Work', messages: [{ role: 'user', text: 'Old'.repeat(50) }] });
  assert.equal(result.turns, 1); assert.equal(events.some(event => event.type === 'summary'), true);
  const controller = new globalThis.AbortController();
  const running = createAgent({ contextSummary: { maxChars: 1, keepLast: 0 }, summarize: () => new Promise(() => {}), turn: () => ({ text: 'Done' }) }).run({ question: 'Work' }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Stop summary')), 10); await assert.rejects(running, /Stop summary/);
});
test('tool failures and unknown tools are model-readable, empty answers fail', async () => {
  let turns = 0;
  const agent = createAgent({ tools: [tool('lookup', () => { throw new Error('Unavailable'); })], turn: ({ messages }) => {
    if (++turns === 1) return { toolCalls: [call(), call('unknown', 'u')] };
    assert.equal(messages.at(-2).result.error, 'Unavailable'); assert.match(messages.at(-1).result.error, /no tool/); return { text: 'Explained' };
  } });
  assert.equal((await agent.run({ question: 'Work' })).state, 'completed');
  await assert.rejects(createAgent({ turn: () => ({ text: '' }) }).run({ question: 'Work' }), /no text/);
});
test('cost exhaustion stops tools before side effects and preserves resumable calls', async () => {
  let runs = 0; const store = createMemoryTaskStore();
  const tools = [tool('lookup', async () => { runs++; return { data: 'ok' }; })];
  const first = createAgent({ store, tools, budget: { maxCost: 1 }, turn: ({ phase, messages }) => {
    if (phase === 'final') { assert.equal(messages.at(-1).role, 'tool'); return { text: 'Budget exhausted' }; }
    return { toolCalls: [call()], usage: { cost: 1, inputTokens: 1, outputTokens: 1 } };
  } });
  const stopped = await first.run({ question: 'Work' }); assert.equal(runs, 0); assert.ok(stopped.pending);
  const resumed = await createAgent({ store, tools, budget: { maxCost: 2 }, turn: () => ({ text: 'Done' }) }).resume(stopped.id);
  assert.equal(resumed.state, 'completed'); assert.equal(runs, 1);
});
test('lost lease aborts a blocked model and fences further saves', async () => {
  const store = createMemoryTaskStore();
  const original = store.renew; store.renew = async () => false;
  const agent = createAgent({ store, leaseMs: 30, turn: () => new Promise(() => {}) });
  await assert.rejects(agent.run({ question: 'Work' }), /lock lost/);
  store.renew = original;
});
test('cancelled tool receives signal and no following tool is dispatched', async () => {
  const controller = new globalThis.AbortController(); let second = 0;
  const agent = createAgent({ tools: [tool('lookup', async (_args, context) => {
    controller.abort(new Error('Stop tools')); assert.equal(context.signal.aborted, true); return { data: 'ignored' };
  }), tool('next', () => { second++; return { data: 'next' }; })], turn: () => ({ toolCalls: [call(), call('next', 'n')] }) });
  await assert.rejects(agent.run({ question: 'Work' }, { signal: controller.signal }), /Stop tools/); assert.equal(second, 0);
});
test('confirmation preparation errors never reach perform', async () => {
  let turns = 0; let performed = 0;
  const agent = createAgent({ tools: [{ ...tool('lookup', () => { throw new Error('Invalid action'); }), kind: 'confirm', perform: () => { performed++; } }], turn: ({ messages }) => {
    if (++turns === 1) return { toolCalls: [call()] };
    assert.equal(messages.at(-1).result.error, 'Invalid action'); return { text: 'Rejected invalid action' };
  } });
  assert.equal((await agent.run({ question: 'Work' })).state, 'completed'); assert.equal(performed, 0);
});
test('confirmation preparation is reused after a restart', async () => {
  let prepared = 0; let turns = 0;
  const tools = [{ ...tool('lookup', () => { prepared++; return { data: { preview: 'change' } }; }), kind: 'confirm', perform: () => ({ data: 'changed' }) }];
  const store = createMemoryTaskStore(); const turn = () => ++turns === 1 ? { toolCalls: [call()] } : { text: 'Done' };
  const waiting = await createAgent({ store, tools, turn }).run({ question: 'Work' });
  assert.equal(waiting.confirmation.prepared.data.preview, 'change');
  await createAgent({ store, tools, turn }).resume(waiting.id, { confirmation: { key: waiting.confirmation.key, approved: true } });
  assert.equal(prepared, 1);
});
