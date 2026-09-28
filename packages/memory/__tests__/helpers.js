const { createMemory, createMemoryStore } = require('../src');

/* A clock that moves one second per reading: every write has its own time. */
function makeClock(start = Date.UTC(2026, 8, 1)) {
  let at = start;
  return () => new Date((at += 1000));
}

function makeIds(prefix = 'm') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

/*
 * A tiny embedding: one dimension per topic word. Two texts about the same
 * topic point the same way; unrelated texts are orthogonal.
 */
const TOPICS = ['music', 'violin', 'math', 'garden', 'travel'];
function topicEmbed(text) {
  const lower = String(text).toLowerCase();
  const vector = TOPICS.map((topic) => (lower.includes(topic) ? 1 : 0));
  return vector.some(Boolean) ? vector : [0, 0, 0, 0, 0.01];
}

function setup(options = {}) {
  const store = options.store || createMemoryStore();
  const memory = createMemory({
    store,
    now: makeClock(),
    generateId: makeIds(),
    ...options
  });
  return { store, memory };
}

const A = { ownerId: 'alice', scope: 'team-1' };
const B = { ownerId: 'bob', scope: 'team-1' };

module.exports = { makeClock, makeIds, topicEmbed, setup, A, B };
