'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wilsonInterval, honestStatistics, calibratePredictions, scoreErrorCosts } = require('../src/autoconscience');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const point = (id, probability, status, domain = 'general', agentId = 'a') => ({ decisionId: id, probability, status, domain, agentId });

test('Wilson matches known two-sided 95% values, including zero and all successes', () => {
  const mid = wilsonInterval(5, 10); close(mid.low, 0.236593090512564); close(mid.high, 0.763406909487436);
  close(wilsonInterval(0, 10).high, 0.2775327998628892); close(wilsonInterval(10, 10).low, 0.7224672001371107);
  close(wilsonInterval(0, 10).low, 0); close(wilsonInterval(10, 10).high, 1);
  assert.equal(wilsonInterval(0, 0), null);
  assert.ok(wilsonInterval(5, 10, 0.99).low < wilsonInterval(5, 10, 0.9).low);
});
for (const args of [[-1, 10], [11, 10], [1, -1], [0.5, 10], [1, NaN], [1, 10, 0.8]]) test(`Wilson rejects invalid counts/level ${JSON.stringify(args)}`, () => assert.throws(() => wilsonInterval(...args), { code: 'invalid_input' }));

test('unknown is never a success or a failure; intervals remain descriptive below threshold', () => {
  const s = honestStatistics(['succeeded', 'failed', ...Array(100).fill('unknown')]);
  assert.deepEqual([s.sampleSize, s.unknown, s.rate, s.status, s.conclusion], [2, 100, 0.5, 'insufficient_data', 'refuse_to_conclude']);
  assert.deepEqual(s.interval, wilsonInterval(1, 2));
  const unknown = honestStatistics(['unknown']); assert.equal(unknown.rate, null); assert.equal(unknown.interval, null);
  assert.equal(honestStatistics(Array(29).fill('succeeded')).status, 'insufficient_data');
  assert.equal(honestStatistics(Array(30).fill('succeeded')).status, 'observed');
  assert.equal(honestStatistics(['failed'], { minimumSample: 1 }).status, 'observed');
});
for (const minimumSample of [0, -1, 1.5, NaN, Infinity, '30']) test(`sample threshold rejects ${minimumSample}`, () => assert.throws(() => honestStatistics([], { minimumSample }), { code: 'invalid_input' }));
test('invalid status cannot alter counts through a prototype key', () => {
  for (const s of ['maybe', 'toString', '__proto__']) assert.throws(() => honestStatistics([s]), { code: 'invalid_input' });
});

test('calibration: exact Brier, signed gap, empty bins and endpoint one', () => {
  const result = calibratePredictions([point('a', 0.8, 'succeeded'), point('b', 0.8, 'failed'), point('c', 1, 'succeeded'), point('d', 0.9, 'unknown')], { minimumSample: 3 })[0];
  close(result.brierScore, (0.04 + 0.64) / 3); close(result.confidenceGap, 0.2); close(result.overconfidence, 0.2);
  assert.equal(result.underconfidence, 0); assert.equal(result.unknown, 1); assert.equal(result.sampleSize, 3);
  assert.equal(result.curve[8].count, 2); assert.equal(result.curve[8].observed, 0.5); assert.equal(result.curve[9].count, 1);
  assert.equal(result.curve[0].predicted, null); assert.equal(result.curve[0].interval, null);
  const low = calibratePredictions([point('l', 0, 'succeeded')])[0]; assert.equal(low.underconfidence, 1); assert.equal(low.brierScore, 1);
  const empty = calibratePredictions([point('u', 0.5, 'unknown')])[0]; assert.equal(empty.brierScore, null); assert.equal(empty.confidenceGap, null);
});
test('calibration partitions agents and domains, refuses duplicate decisions', () => {
  assert.equal(calibratePredictions([point('d', 0.5, 'succeeded'), point('d', 0.5, 'failed', 'other'), point('d', 0.5, 'unknown', 'general', 'b')]).length, 3);
  assert.throws(() => calibratePredictions([point('d', 0.5, 'succeeded'), point('d', 0.5, 'failed')]), { code: 'invalid_input' });
  for (const buckets of [0, 101, 1.5]) assert.throws(() => calibratePredictions([], { buckets }), { code: 'invalid_input' });
  assert.throws(() => calibratePredictions([point('d', 2, 'failed')]), { code: 'invalid_input' });
});
test('asymmetric costs: one missed positive outweighs ten false alerts; unknown excluded', () => {
  const list = [...Array.from({ length: 10 }, (_, i) => point(`fp${i}`, 1, 'failed')), point('fn', 0, 'succeeded'), point('u', 1, 'unknown')];
  const score = scoreErrorCosts(list, { domain: 'general', falsePositive: 1, falseNegative: 20 });
  assert.deepEqual([score.falsePositives, score.falseNegatives, score.totalCost, score.sampleSize, score.unknown], [10, 1, 30, 11, 1]);
  close(score.weightedScore, 30 / 11);
  assert.equal(scoreErrorCosts([point('u', 1, 'unknown')], { domain: 'general', falsePositive: 0, falseNegative: 0 }).weightedScore, null);
  assert.throws(() => scoreErrorCosts(list, { domain: 'other', falsePositive: 1, falseNegative: 1 }), { code: 'invalid_input' });
  assert.throws(() => scoreErrorCosts([], { domain: 'general', falsePositive: -1, falseNegative: 1 }), { code: 'invalid_input' });
});
