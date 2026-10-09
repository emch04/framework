'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens, normalizeBudget, usageOf, budgetReason } = require('../src');
test('budget validates boundaries and preserves zero', () => {
  assert.equal(normalizeBudget({ maxTurns: 0 }).maxTurns, 0);
  for (const key of ['maxMs', 'maxTurns', 'maxTokens', 'maxCost']) for (const value of [-1, NaN, Infinity, '3']) assert.throws(() => normalizeBudget({ [key]: value }));
  assert.throws(() => normalizeBudget({ maxTurns: 0.5 }));
  assert.equal(estimateTokens('12345'), 2);
});
test('usage uses provider counts, aliases, estimates and prices', () => {
  assert.deepEqual(usageOf('', { usage: { inputTokens: 10, outputTokens: 5 } }, { inputPerMillion: 2, outputPerMillion: 4 }), { inputTokens: 10, outputTokens: 5, cost: 0.00004, estimated: false });
  assert.equal(usageOf('', { usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0.2 } }).cost, 0.2);
  const estimate = usageOf('12345', { text: 'output', usage: { inputTokens: -1 } });
  assert.equal(estimate.inputTokens, 2); assert.equal(estimate.estimated, true); assert.ok(estimate.outputTokens > 0);
  assert.throws(() => usageOf('', {}, { inputPerMillion: -1 }));
});
test('all budgets stop at their boundary', () => {
  const base = { turns: 2, elapsedMs: 20, usage: { inputTokens: 6, outputTokens: 4, cost: 0.5 } };
  for (const [key, limit, reason] of [['maxTurns', 2, 'turns'], ['maxMs', 20, 'time'], ['maxTokens', 10, 'tokens'], ['maxCost', 0.5, 'cost']]) assert.equal(budgetReason(base, normalizeBudget({ [key]: limit })), reason);
  assert.equal(budgetReason(base, normalizeBudget()), null);
});
