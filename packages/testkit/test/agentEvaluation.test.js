'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAgent } = require('../src/agentEvaluation');
test('evaluates fixture calls, text and aggregate score', async () => {
  const report = await evaluateAgent({ scenarios: [
    { id: 'ok', question: 'Compute', tools: [{ name: 'sum', run: ({ a, b }) => a + b }], expect: { tools: ['sum'], content: ['3', /Result/g] } },
    { id: 'missing', question: 'Missing', expect: { tools: ['sum'], content: ['absent'] } }
  ], run: async ({ tools }) => ({ text: tools.length ? `Result ${await tools[0].run({ a: 1, b: 2 })}` : 'Empty' }) });
  assert.equal(report.total, 2); assert.equal(report.passed, 1); assert.equal(report.score, 0.5);
  assert.deepEqual(report.results[0].calls[0], { name: 'sum', args: { a: 1, b: 2 } });
});
test('custom scoring, runner failure and invalid scores remain scenario-local', async () => {
  const report = await evaluateAgent({ scenarios: [
    { id: 'custom', question: 'Work', score: async ({ text }) => text === 'Answer' ? 0.75 : 0 },
    { id: 'invalid', question: 'Work', score: () => 2 },
    { id: 'failure', question: 'fail' }
  ], run: ({ question }) => { if (question === 'fail') throw new Error('Failed'); return 'Answer'; } });
  assert.equal(report.results[0].score, 0.75); assert.match(report.results[1].error, /Score/); assert.equal(report.results[2].error, 'Failed');
});
test('empty report, validation and cancellation', async () => {
  assert.deepEqual(await evaluateAgent({ scenarios: [], run() {} }), { results: [], score: 0, total: 0, passed: 0 });
  await assert.rejects(evaluateAgent({}), /required/);
  await assert.rejects(evaluateAgent({ scenarios: [{}], run() {} }), /scenario/);
  const controller = new globalThis.AbortController(); controller.abort(new Error('Stopped'));
  await assert.rejects(evaluateAgent({ scenarios: [{ id: 'a', question: 'Work' }], run() {}, signal: controller.signal }), /Stopped/);
});
test('cancellation interrupts a runner that never settles', async () => {
  const controller = new globalThis.AbortController();
  const running = evaluateAgent({ scenarios: [{ id: 'blocked', question: 'Work' }], run: () => new Promise(() => {}), signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Cancelled evaluation')), 10);
  await assert.rejects(running, /Cancelled evaluation/);
});
test('custom scoring can inspect order and cancellation interrupts scoring', async () => {
  const report = await evaluateAgent({ scenarios: [{ id: 'ordered', question: 'Work', tools: [{ name: 'read', run: () => 'data' }], score: ({ calls }) => calls.length === 2 && calls[1].args.page === 2 ? 1 : 0 }], run: async ({ tools }) => { await tools[0].run({ page: 1 }); await tools[0].run({ page: 2 }); return 'Done'; } });
  assert.equal(report.passed, 1);
  const controller = new globalThis.AbortController();
  const running = evaluateAgent({ scenarios: [{ id: 'score', question: 'Work', score: () => new Promise(() => {}) }], run: () => 'Done', signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Cancelled score')), 10);
  await assert.rejects(running, /Cancelled score/);
});
