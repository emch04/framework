'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contextBoundary, summarizeContext } = require('../src');
test('summary keeps tail and plan, and retains complete tool exchanges', async () => {
  const messages = [{ role: 'user', text: 'old'.repeat(100) }, { role: 'assistant', toolCalls: [] }, { role: 'tool', result: 2 }, { role: 'user', text: 'new' }];
  assert.equal(contextBoundary(messages, { maxTokens: 1, keepLast: 2 }), 1);
  const plan = [{ id: 'a', text: 'Work', state: 'todo' }];
  let received;
  assert.equal(await summarizeContext(messages, plan, { maxChars: 1, keepLast: 2 }, async (input) => { received = input; return 'Old work'; }), true);
  assert.equal(received.plan, plan); assert.equal(received.messages.length, 1);
  assert.equal(messages.length, 4); assert.equal(messages[1].role, 'assistant'); assert.equal(messages.at(-1).text, 'new');
  assert.equal(await summarizeContext(messages, plan, { maxChars: 99999 }, () => { throw new Error(); }), false);
});
test('summary validation leaves history unchanged on failure', async () => {
  for (const options of [{ keepLast: -1 }, { keepLast: 0.1 }, { maxChars: -1 }, { maxTokens: NaN }]) assert.throws(() => contextBoundary([], options));
  const messages = [{ role: 'user', text: 'old' }];
  await assert.rejects(summarizeContext(messages, [], { maxChars: 0, keepLast: 0 }, () => ''), /non-empty/);
  assert.equal(messages[0].text, 'old');
});
