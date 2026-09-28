/**
 * The store contract, as a test suite. An adapter for a real database proves
 * it behaves like the reference store:
 *
 *   const { runStoreContract } = require('@astratra/memory');
 *   runStoreContract(async () => createPostgresMemoryStore(await freshPool()));
 *
 * It uses the test runner's describe/test/expect (jest or a compatible one);
 * pass them explicitly when they are not globals. Optional methods (search,
 * claimRef/releaseRef, listNeedingVector) are checked only when the store has
 * them.
 */

let sequence = 0;

function record(overrides = {}) {
  sequence += 1;
  const at = overrides.createdAt || new Date(Date.UTC(2026, 0, 1, 0, 0, sequence));
  return {
    id: `contract-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: 'owner-a',
    scope: 'scope-1',
    role: 'member',
    text: 'likes long walks',
    kind: 'preference',
    importance: 3,
    source: { channel: 'auto' },
    vector: null,
    vectorSource: null,
    supersededBy: null,
    seenAt: null,
    lastUsedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

function runStoreContract(makeStore, runner = {}) {
  const describe = runner.describe || globalThis.describe;
  const test = runner.test || globalThis.test;
  const expect = runner.expect || globalThis.expect;
  if (typeof describe !== 'function' || typeof test !== 'function' || typeof expect !== 'function') {
    throw new Error('runStoreContract needs describe, test and expect (pass them, or run it inside jest).');
  }

  const A1 = { ownerId: 'owner-a', scope: 'scope-1' };
  const A2 = { ownerId: 'owner-a', scope: 'scope-2' };
  const B1 = { ownerId: 'owner-b', scope: 'scope-1' };
  const time = (value) => new Date(value).getTime();

  describe('memory store contract', () => {
    test('insert then get returns the same record, and returned objects are copies', async () => {
      const store = await makeStore();
      const row = record({ source: { channel: 'auto', ref: 'c1' }, vector: [0.1, 0.2], vectorSource: 'm1' });
      await store.insert(row);
      const got = await store.get(A1, row.id);
      expect(got).toMatchObject({ id: row.id, ownerId: 'owner-a', scope: 'scope-1', text: row.text, kind: 'preference', importance: 3, supersededBy: null });
      expect(got.source).toEqual({ channel: 'auto', ref: 'c1' });
      expect(got.vector).toEqual([0.1, 0.2]);
      expect(got.vectorSource).toBe('m1');
      expect(time(got.createdAt)).toBe(time(row.createdAt));
      got.text = 'changed outside';
      expect((await store.get(A1, row.id)).text).toBe(row.text);
    });

    test('a record is invisible from another owner or another scope', async () => {
      const store = await makeStore();
      const row = record();
      await store.insert(row);
      expect(await store.get(B1, row.id)).toBeNull();
      expect(await store.get(A2, row.id)).toBeNull();
      expect(await store.list(B1)).toEqual([]);
      expect(await store.list(A2)).toEqual([]);
      expect(await store.update(B1, row.id, { text: 'stolen' })).toBeNull();
      expect(await store.remove(B1, [row.id])).toBe(0);
      expect(await store.removeAll(A2)).toBe(0);
      expect((await store.get(A1, row.id)).text).toBe(row.text);
    });

    test('list: active by default, newest first, with state, kinds, channel, seen, dates and limit filters', async () => {
      const store = await makeStore();
      const old = record({ createdAt: new Date('2026-01-01T00:00:00Z'), kind: 'goal' });
      const mid = record({ createdAt: new Date('2026-02-01T00:00:00Z'), source: { channel: 'background' } });
      const recent = record({ createdAt: new Date('2026-03-01T00:00:00Z'), source: { channel: 'background' }, seenAt: new Date('2026-03-02T00:00:00Z') });
      const replaced = record({ createdAt: new Date('2026-04-01T00:00:00Z'), supersededBy: recent.id });
      for (const row of [old, mid, recent, replaced]) await store.insert(row);

      expect((await store.list(A1)).map((row) => row.id)).toEqual([recent.id, mid.id, old.id]);
      expect((await store.list(A1, { state: 'superseded' })).map((row) => row.id)).toEqual([replaced.id]);
      expect((await store.list(A1, { state: 'all' })).map((row) => row.id)).toEqual([replaced.id, recent.id, mid.id, old.id]);
      expect((await store.list(A1, { state: 'superseded', supersededBy: recent.id })).map((row) => row.id)).toEqual([replaced.id]);
      expect((await store.list(A1, { kinds: ['goal'] })).map((row) => row.id)).toEqual([old.id]);
      expect((await store.list(A1, { channel: 'background', seen: false })).map((row) => row.id)).toEqual([mid.id]);
      expect((await store.list(A1, { createdAfter: new Date('2026-01-15T00:00:00Z'), createdBefore: new Date('2026-02-15T00:00:00Z') })).map((row) => row.id)).toEqual([mid.id]);
      expect((await store.list(A1, { limit: 2 })).map((row) => row.id)).toEqual([recent.id, mid.id]);
    });

    test('update patches in place, never moves a record, and onlyActive refuses a superseded one', async () => {
      const store = await makeStore();
      const row = record();
      await store.insert(row);
      const updated = await store.update(A1, row.id, { importance: 5, ownerId: 'owner-b', scope: 'scope-2' });
      expect(updated).toMatchObject({ id: row.id, importance: 5, ownerId: 'owner-a', scope: 'scope-1' });
      expect(await store.update(A1, row.id, { supersededBy: 'next' }, { onlyActive: true })).not.toBeNull();
      expect(await store.update(A1, row.id, { importance: 1 }, { onlyActive: true })).toBeNull();
      expect((await store.get(A1, row.id)).importance).toBe(5);
      expect(await store.update(A1, 'missing-id', { importance: 1 })).toBeNull();
    });

    test('remove and removeAll count what they erased, in their place only', async () => {
      const store = await makeStore();
      const a = record();
      const b = record();
      const other = record({ scope: 'scope-2' });
      for (const row of [a, b, other]) await store.insert(row);
      expect(await store.remove(A1, [a.id, 'missing-id'])).toBe(1);
      expect(await store.removeAll(A1)).toBe(1);
      expect(await store.list(A1, { state: 'all' })).toEqual([]);
      expect((await store.list(A2)).map((row) => row.id)).toEqual([other.id]);
    });

    test('purgeOwner erases one owner in every scope, settings included, and nobody else', async () => {
      const store = await makeStore();
      const mine = [record(), record({ scope: 'scope-2' })];
      const theirs = record({ ownerId: 'owner-b' });
      for (const row of [...mine, theirs]) await store.insert(row);
      await store.setSettings(A1, { paused: true });
      await store.setSettings(B1, { paused: true });
      const counts = await store.purgeOwner('owner-a');
      expect(counts.memories).toBe(2);
      expect(counts.settings).toBeGreaterThanOrEqual(1);
      expect(await store.list(A1, { state: 'all' })).toEqual([]);
      expect(await store.list(A2, { state: 'all' })).toEqual([]);
      expect((await store.getSettings(A1)).paused).toBe(false);
      expect((await store.list(B1)).map((row) => row.id)).toEqual([theirs.id]);
      expect((await store.getSettings(B1)).paused).toBe(true);
    });

    test('settings default to not paused and belong to one place', async () => {
      const store = await makeStore();
      expect((await store.getSettings(A1)).paused).toBe(false);
      expect((await store.setSettings(A1, { paused: true })).paused).toBe(true);
      expect((await store.getSettings(A1)).paused).toBe(true);
      expect((await store.getSettings(A2)).paused).toBe(false);
      expect((await store.getSettings(B1)).paused).toBe(false);
      expect((await store.setSettings(A1, { paused: false })).paused).toBe(false);
    });

    test('claimRef (optional) claims once per place; releaseRef frees it', async () => {
      const store = await makeStore();
      if (typeof store.claimRef !== 'function') return;
      expect(await store.claimRef(A1, 'conversation-1')).toBe(true);
      expect(await store.claimRef(A1, 'conversation-1')).toBe(false);
      expect(await store.claimRef(B1, 'conversation-1')).toBe(true);
      if (typeof store.releaseRef === 'function') {
        await store.releaseRef(A1, 'conversation-1');
        expect(await store.claimRef(A1, 'conversation-1')).toBe(true);
      }
    });

    test('search (optional) stays in its place, skips superseded records and compares one vector source only', async () => {
      const store = await makeStore();
      if (typeof store.search !== 'function') return;
      const near = record({ text: 'plays the violin every evening', vector: [1, 0], vectorSource: 'm1' });
      const otherSource = record({ text: 'unrelated', vector: [1, 0], vectorSource: 'm2' });
      const replaced = record({ text: 'plays the violin badly', vector: [1, 0], vectorSource: 'm1', supersededBy: near.id });
      const stranger = record({ ownerId: 'owner-b', text: 'plays the violin too', vector: [1, 0], vectorSource: 'm1' });
      for (const row of [near, otherSource, replaced, stranger]) await store.insert(row);
      const found = await store.search(A1, { text: 'violin evening', vector: [1, 0], vectorSource: 'm1', limit: 10 });
      expect(found.semantic.map((row) => row.id)).toEqual([near.id]);
      expect(found.lexical.map((row) => row.id)).toEqual([near.id]);
    });

    test('listNeedingVector (optional) returns active records without a vector, or from another source', async () => {
      const store = await makeStore();
      if (typeof store.listNeedingVector !== 'function') return;
      const missing = record({ ownerId: 'owner-z' });
      const other = record({ ownerId: 'owner-z', vector: [1], vectorSource: 'old' });
      const fine = record({ ownerId: 'owner-z', vector: [1], vectorSource: 'new' });
      const replaced = record({ ownerId: 'owner-z', supersededBy: fine.id });
      for (const row of [missing, other, fine, replaced]) await store.insert(row);
      const ids = (await store.listNeedingVector({ limit: 50, source: 'new' })).map((row) => row.id);
      expect(ids).toEqual(expect.arrayContaining([missing.id, other.id]));
      expect(ids).not.toContain(fine.id);
      expect(ids).not.toContain(replaced.id);
      const withoutSource = (await store.listNeedingVector({ limit: 50 })).map((row) => row.id);
      expect(withoutSource).toContain(missing.id);
      expect(withoutSource).not.toContain(other.id);
    });
  });
}

module.exports = { runStoreContract, contractRecord: record };
