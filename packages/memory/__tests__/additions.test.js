const { createMemory, createMemoryStore, createMemoryHandlers, createMemoryTools, runStoreContract, DEFAULT_MAX_ACTIVE, DUPLICATE_MODES } = require('../src');
const { setup, topicEmbed, A, B } = require('./helpers');

describe('the cap: 1000 by default, adjustable, with a trigger threshold', () => {
  test('the default is 1000 and the options are validated', () => {
    expect(DEFAULT_MAX_ACTIVE).toBe(1000);
    expect(DUPLICATE_MODES).toEqual(['replace', 'reinforce']);
    expect(() => createMemory({ store: createMemoryStore(), onDuplicate: 'merge' })).toThrow(/onDuplicate/);
  });

  test('1000 stay, the 1001st pushes out the least important', async () => {
    const store = createMemoryStore();
    const { memory } = setup({ store });
    for (let i = 0; i < 1000; i += 1) {
      await store.insert({
        id: `seed${i}`, ownerId: A.ownerId, scope: A.scope, role: null, text: `memory number ${i}`, kind: 'fact', importance: i === 0 ? 1 : 3,
        source: { channel: 'auto' }, vector: null, vectorSource: null, supersededBy: null, seenAt: null, lastUsedAt: null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i))
      });
    }
    await memory.remember(A, { text: 'The thousand and first', kind: 'fact', importance: 3 });
    const all = await memory.list(A);
    expect(all).toHaveLength(1000);
    expect(all.map((m) => m.id)).not.toContain('seed0');
  });

  test('maxActive is adjustable and 0 or null means no cap', async () => {
    const small = setup({ maxActive: 1 }).memory;
    await small.remember(A, { text: 'First', kind: 'fact', importance: 1 });
    await small.remember(A, { text: 'Second', kind: 'fact', importance: 2 });
    expect((await small.list(A)).map((m) => m.text)).toEqual(['Second']);
    const none = setup({ maxActive: null }).memory;
    for (let i = 0; i < 5; i += 1) await none.remember(A, { text: `Fact ${i}`, kind: 'fact' });
    expect(await none.list(A)).toHaveLength(5);
  });

  test('trimAbove: nothing is removed until the threshold is passed, then the place comes back to maxActive', async () => {
    const { memory } = setup({ maxActive: 3, trimAbove: 5 });
    for (let i = 1; i <= 5; i += 1) await memory.remember(A, { text: `Fact ${i}`, kind: 'fact', importance: i });
    expect(await memory.list(A)).toHaveLength(5);
    await memory.remember(A, { text: 'Fact 6', kind: 'fact', importance: 5 });
    const left = await memory.list(A);
    expect(left).toHaveLength(3);
    expect(left.map((m) => m.text).sort()).toEqual(['Fact 4', 'Fact 5', 'Fact 6']);
  });

  test('a threshold below maxActive is ignored (never trims under the cap)', async () => {
    const { memory } = setup({ maxActive: 3, trimAbove: 1 });
    for (let i = 1; i <= 3; i += 1) await memory.remember(A, { text: `Fact ${i}`, kind: 'fact' });
    expect(await memory.list(A)).toHaveLength(3);
  });

  test('a person under the threshold costs no extra listing', async () => {
    const store = createMemoryStore();
    const list = jest.spyOn(store, 'list');
    const { memory } = setup({ store });
    await memory.remember(A, { text: 'Likes tea', kind: 'preference' });
    expect(list).toHaveBeenCalledTimes(1); // the duplicates check only: the cap reuses its count
  });
});

describe('onDuplicate: reinforce', () => {
  test('the default still replaces: a new id, the old one kept behind it', async () => {
    const { memory } = setup();
    const first = await memory.remember(A, { text: 'Likes tea', kind: 'preference', importance: 2 });
    const again = await memory.remember(A, { text: 'likes tea', kind: 'preference', importance: 4 });
    expect(again.memory.id).not.toBe(first.memory.id);
    expect(again.supersededId).toBe(first.memory.id);
    expect(again.reinforced).toBeUndefined();
  });

  test('reinforce keeps the same id, the older text and kind, and the higher importance', async () => {
    const { memory } = setup({ onDuplicate: 'reinforce' });
    const first = await memory.remember(A, { text: 'Likes tea', kind: 'preference', importance: 2 });
    const again = await memory.remember(A, { text: 'LIKES TEA!', kind: 'fact', importance: 4 });
    expect(again).toMatchObject({ ok: true, reinforced: true, supersededId: null });
    expect(again.memory).toMatchObject({ id: first.memory.id, text: 'Likes tea', kind: 'preference', importance: 4 });
    expect(new Date(again.memory.updatedAt).getTime()).toBeGreaterThan(new Date(first.memory.updatedAt).getTime());
    expect(new Date(again.memory.createdAt).getTime()).toBe(new Date(first.memory.createdAt).getTime());
    const lower = await memory.remember(A, { text: 'Likes tea', kind: 'preference', importance: 1 });
    expect(lower.memory.importance).toBe(4);
    expect(await memory.list(A)).toHaveLength(1);
  });

  test('it is chosen per call as well, in both directions', async () => {
    const reinforcing = setup({ onDuplicate: 'reinforce' }).memory;
    await reinforcing.remember(A, { text: 'Likes tea', kind: 'fact' });
    const replaced = await reinforcing.remember(A, { text: 'Likes tea', kind: 'fact', onDuplicate: 'replace' });
    expect(replaced.supersededId).not.toBeNull();
    const replacing = setup().memory;
    const first = await replacing.remember(A, { text: 'Likes tea', kind: 'fact' });
    const same = await replacing.remember(A, { text: 'Likes tea', kind: 'fact', onDuplicate: 'reinforce' });
    expect(same.memory.id).toBe(first.memory.id);
  });

  test('meaning counts too, the vector it lacked is taken, and the cap never runs', async () => {
    const store = createMemoryStore();
    let embedding = true;
    const { memory } = setup({
      store,
      onDuplicate: 'reinforce',
      embed: async (text) => { if (!embedding) throw new Error('down'); return { vector: topicEmbed(text), source: 'm1' }; }
    });
    embedding = false;
    const first = await memory.remember(A, { text: 'Plays the violin', kind: 'fact', importance: 2 });
    expect(first.memory.hasVector).toBe(false);
    embedding = true;
    // same words: found by text, then the vector is filled in
    const again = await memory.remember(A, { text: 'plays the violin', kind: 'fact', importance: 3 });
    expect(again.reinforced).toBe(true);
    expect((await store.get(A, first.memory.id)).vector).toEqual(topicEmbed('violin'));
    // same meaning, other words
    const meaning = await memory.remember(A, { text: 'Violin lessons on Friday', kind: 'event', importance: 5 });
    expect(meaning.reinforced).toBe(true);
    expect(meaning.memory.id).toBe(first.memory.id);
    expect(meaning.memory.importance).toBe(5);
  });

  test('one person does not reinforce another person\'s memory', async () => {
    const { memory } = setup({ onDuplicate: 'reinforce' });
    const mine = await memory.remember(A, { text: 'Likes tea', kind: 'fact' });
    const theirs = await memory.remember(B, { text: 'Likes tea', kind: 'fact' });
    expect(theirs.memory.id).not.toBe(mine.memory.id);
    expect(theirs.reinforced).toBeUndefined();
  });

  test('a memory changed meanwhile is written as a new one', async () => {
    const store = createMemoryStore();
    const { memory } = setup({ store, onDuplicate: 'reinforce' });
    const first = await memory.remember(A, { text: 'Likes tea', kind: 'fact' });
    const update = store.update.bind(store);
    store.update = async (where, id, patch, options) => (patch.importance !== undefined && options && options.onlyActive ? null : update(where, id, patch, options));
    const again = await memory.remember(A, { text: 'Likes tea', kind: 'fact', importance: 5 });
    expect(again.ok).toBe(true);
    expect(again.reinforced).toBeUndefined();
    expect(again.memory.id).not.toBe(first.memory.id);
  });

  test('consolidation reinforces too, and the tool says so and offers no undo', async () => {
    const { memory } = setup({
      onDuplicate: 'reinforce',
      llm: async () => JSON.stringify({ facts: [{ text: 'Likes tea', kind: 'fact', importance: 5 }], corrections: [], summary: 's' })
    });
    const first = await memory.remember(A, { text: 'Likes tea', kind: 'fact', importance: 1 });
    expect(await memory.consolidate(A, { transcript: 'I like tea', ref: 'c1' })).toMatchObject({ status: 'done', added: 1 });
    expect(await memory.list(A)).toHaveLength(1);
    expect((await memory.get(A, first.memory.id)).importance).toBe(5);

    const tools = createMemoryTools({ memory, roles: ['member'], whereOf: (ctx) => ctx.where });
    const remember = tools.find((tool) => tool.name === 'remember');
    const out = await remember.handler({ text: 'likes tea', kind: 'fact', importance: 2 }, { where: A });
    expect(out).toMatchObject({ ok: true, code: 'memory_saved', reinforced: true, undo: null, memory: { id: first.memory.id } });
  });
});

describe('markUsed', () => {
  test('marks the active memories of the place as used, without a search', async () => {
    const { memory, store } = setup();
    const a = await memory.remember(A, { text: 'Likes tea', kind: 'fact' });
    const b = await memory.remember(A, { text: 'Likes cake', kind: 'fact' });
    const theirs = await memory.remember(B, { text: 'Likes pie', kind: 'fact' });
    expect(a.memory.lastUsedAt).toBeNull();
    expect(await memory.markUsed(A, [a.memory.id, a.memory.id, 'unknown', theirs.memory.id])).toBe(1);
    expect((await store.get(A, a.memory.id)).lastUsedAt).toBeInstanceOf(Date);
    expect((await store.get(A, b.memory.id)).lastUsedAt).toBeNull();
    expect((await store.get(B, theirs.memory.id)).lastUsedAt).toBeNull();
    expect(await memory.markUsed(A, [])).toBe(0);
    expect(await memory.markUsed(A)).toBe(0);
  });

  test('a replaced memory is not marked, and used memories outlast unused ones under the cap', async () => {
    const { memory } = setup({ maxActive: 2 });
    const old = await memory.remember(A, { text: 'Likes tea', kind: 'fact', importance: 3 });
    const fixed = await memory.update(A, old.memory.id, { text: 'Likes green tea' });
    expect(await memory.markUsed(A, [old.memory.id])).toBe(0);
    const b = await memory.remember(A, { text: 'Likes cake', kind: 'fact', importance: 3 });
    expect(await memory.markUsed(A, [fixed.memory.id])).toBe(1);
    await memory.remember(A, { text: 'Likes pie', kind: 'fact', importance: 3 });
    const left = (await memory.list(A)).map((m) => m.id);
    expect(left).toContain(fixed.memory.id);
    expect(left).not.toContain(b.memory.id);
  });

  test('without an owner it throws', async () => {
    const { memory } = setup();
    await expect(memory.markUsed({}, ['x'])).rejects.toMatchObject({ code: 'invalid_where' });
  });
});

describe('pause and resume', () => {
  test('pause stops writing, resume starts again, per person', async () => {
    const { memory } = setup();
    expect(await memory.pause(A)).toBe(true);
    expect(await memory.isPaused(A)).toBe(true);
    expect(await memory.isPaused(B)).toBe(false);
    expect(await memory.remember(A, { text: 'Likes tea', kind: 'fact' })).toEqual({ ok: false, reason: 'paused' });
    expect(await memory.resume(A)).toBe(false);
    expect(await memory.isPaused(A)).toBe(false);
    expect((await memory.remember(A, { text: 'Likes tea', kind: 'fact' })).ok).toBe(true);
  });

  test('the handlers offer them, and they keep working with the AI off', async () => {
    const { memory } = setup();
    const isAiEnabled = jest.fn(() => false);
    const handlers = createMemoryHandlers({ memory, isAiEnabled });
    expect(await handlers.pause(A)).toEqual({ ok: true, paused: true });
    expect((await handlers.list(A)).paused).toBe(true);
    expect(await handlers.resume(A)).toEqual({ ok: true, paused: false });
    expect(isAiEnabled).not.toHaveBeenCalled();
  });
});

describe('the store contract with places made by the store\'s own factories', () => {
  /* A store whose scope is a foreign key: an unknown scope is refused on write, like a database would. */
  const organisations = new Set();
  const withForeignKey = () => {
    const store = createMemoryStore();
    const insert = store.insert.bind(store);
    store.insert = async (record) => {
      if (!organisations.has(record.scope)) throw new Error('foreign key violation');
      return insert(record);
    };
    return store;
  };
  let counter = 0;
  runStoreContract(withForeignKey, {
    makeScope: (name) => {
      const id = `org-${name}-${++counter}`;
      organisations.add(id);
      return id;
    },
    makeOwner: (name) => `person-${name}`
  });

  test('the factories are called with the names the suite uses, for the store being tested', async () => {
    const seen = [];
    const calls = [];
    const fake = { describe: (name, fn) => fn(), test: (name, fn) => calls.push(fn), expect: undefined };
    runStoreContract(() => createMemoryStore(), {
      describe: fake.describe,
      test: fake.test,
      makeScope: (name, store) => { seen.push(['scope', name, typeof store.insert]); return name; },
      makeOwner: (name, store) => { seen.push(['owner', name, typeof store.insert]); return name; }
    });
    await calls[0]();
    expect(seen.map((row) => row[1])).toEqual(expect.arrayContaining(['scope-1', 'scope-2', 'owner-a', 'owner-b']));
    expect(seen.every((row) => row[2] === 'function')).toBe(true);
  });
});
