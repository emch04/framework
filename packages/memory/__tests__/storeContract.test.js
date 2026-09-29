const { createMemoryStore, runStoreContract } = require('../src');

/* The reference store passes its own contract… */
runStoreContract(() => createMemoryStore());

/* …and so does a store that implements only the required methods. */
describe('a minimal store', () => {
  runStoreContract(() => {
    const store = createMemoryStore();
    delete store.search;
    delete store.claimRef;
    delete store.releaseRef;
    delete store.listNeedingVector;
    return store;
  });
});


/* A store whose ids have a shape brings its own, and the small `expect` serves a runner that has none (node:test). */
describe('the contract on its own terms', () => {
  const { randomUUID } = require('crypto');
  const { miniExpect } = require('../src/testing/miniExpect');
  runStoreContract(() => createMemoryStore(), { newId: randomUUID, expect: miniExpect });

  test('miniExpect passes what is true and fails what is not, with and without .not', () => {
    expect(() => miniExpect(1).toBe(1)).not.toThrow();
    expect(() => miniExpect(1).toBe(2)).toThrow(/to be/);
    expect(() => miniExpect(1).not.toBe(1)).toThrow(/not to be/);
    expect(() => miniExpect({ a: [1, { b: undefined }] }).toEqual({ a: [1, {}] })).not.toThrow();
    expect(() => miniExpect([1, 2]).toEqual([1])).toThrow();
    expect(() => miniExpect(new Date(5)).toEqual(new Date(5))).not.toThrow();
    expect(() => miniExpect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } })).not.toThrow();
    expect(() => miniExpect({ a: 1 }).toMatchObject({ a: 2 })).toThrow();
    expect(() => miniExpect(['a', 'b', 'c']).toEqual(miniExpect.arrayContaining(['c', 'a']))).not.toThrow();
    expect(() => miniExpect(['a']).toEqual(miniExpect.arrayContaining(['z']))).toThrow();
    expect(() => miniExpect(null).toBeNull()).not.toThrow();
    expect(() => miniExpect(3).not.toBeNull()).not.toThrow();
    expect(() => miniExpect(3).toBeGreaterThanOrEqual(3)).not.toThrow();
    expect(() => miniExpect(['a']).toContain('a')).not.toThrow();
    expect(() => miniExpect(['a']).not.toContain('a')).toThrow();
  });
});
