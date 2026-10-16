'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Tool budget store scenarios, run against one store. `makeStore()` returns
 * `{ store, cleanup? }` (a fresh empty store each time) or `{ unavailable }`.
 */
function toolBudgetContract(label, makeStore, options = {}) {
  const suite = (name, fn) => test(`${label} tool budget: ${name}`, { skip: options.skip }, async (t) => {
    const stores = await makeStore();
    if (stores.unavailable) { t.skip(stores.unavailable); return; }
    try { await fn(stores.store); } finally { await stores.cleanup?.(); }
  });
  const at = '2026-10-15T10:00:00.000Z';

  suite('an empty period is zero; a consumption adds up inside its scope and period only', async (store) => {
    assert.equal(await store.getSpent('s1', '2026-10'), 0);
    assert.deepEqual(await store.addSpend({ scope: 's1', period: '2026-10', id: 'a', amount: 300, at }), { added: true, spent: 300 });
    assert.deepEqual(await store.addSpend({ scope: 's1', period: '2026-10', id: 'b', amount: 200, at }), { added: true, spent: 500 });
    assert.deepEqual(await store.addSpend({ scope: 's1', period: '2026-11', id: 'c', amount: 7, at }), { added: true, spent: 7 });
    assert.deepEqual(await store.addSpend({ scope: 's2', period: '2026-10', id: 'd', amount: 1, at }), { added: true, spent: 1 });
    assert.deepEqual([await store.getSpent('s1', '2026-10'), await store.getSpent('s1', '2026-11'), await store.getSpent('s2', '2026-10')], [500, 7, 1]);
  });

  suite('a replayed id adds nothing, even with another amount', async (store) => {
    await store.addSpend({ scope: 's', period: '2026-10', id: 'once', amount: 100, at });
    assert.deepEqual(await store.addSpend({ scope: 's', period: '2026-10', id: 'once', amount: 999, at }), { added: false, spent: 100 });
    assert.equal(await store.getSpent('s', '2026-10'), 100);
  });

  suite('concurrent consumptions all count, and a repeated id counts once', async (store) => {
    const results = await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => store.addSpend({ scope: 's', period: '2026-10', id: `n${i}`, amount: 5, at })),
      ...Array.from({ length: 5 }, () => store.addSpend({ scope: 's', period: '2026-10', id: 'same', amount: 1000, at }))
    ]);
    assert.equal(results.filter((r) => r.added).length, 21);
    assert.equal(await store.getSpent('s', '2026-10'), 20 * 5 + 1000);
  });

  suite('large integer amounts stay exact (no floating point)', async (store) => {
    const big = 9_007_199_254_000_000;
    await store.addSpend({ scope: 's', period: '2026-10', id: 'big', amount: big, at });
    assert.equal(await store.getSpent('s', '2026-10'), big);
  });
}

module.exports = { toolBudgetContract };
