const { createMemory, createMemoryStore, patternRule, MemoryError } = require('../src');
const { setup, topicEmbed, A, B } = require('./helpers');

describe('remember', () => {
  test('keeps a clean memory with its channel, and returns no vector', async () => {
    const { memory } = setup({ embed: async (text) => ({ vector: topicEmbed(text), source: 'm1' }) });
    const result = await memory.remember(A, { text: '  Loves **music**   at night ', kind: 'preference', importance: 4, role: 'member' });
    expect(result.ok).toBe(true);
    expect(result.memory).toMatchObject({ text: 'Loves music at night', kind: 'preference', importance: 4, role: 'member', ownerId: 'alice', scope: 'team-1', hasVector: true });
    expect(result.memory.source.channel).toBe('auto');
    expect(result.memory).not.toHaveProperty('vector');
    const explicit = await memory.remember(A, { text: 'Plans a garden', kind: 'goal', explicit: true });
    expect(explicit.memory.source.channel).toBe('explicit');
  });

  test('refuses with codes: empty, too long, unknown kind, kind not allowed for the role', async () => {
    const { memory, store } = setup({ maxTextLength: 20, roleKinds: { learner: ['goal', 'preference'] } });
    expect(await memory.remember(A, { text: '  ', kind: 'fact' })).toEqual({ ok: false, reason: 'empty' });
    expect(await memory.remember(A, { text: 'x'.repeat(21), kind: 'fact' })).toEqual({ ok: false, reason: 'too_long' });
    expect(await memory.remember(A, { text: 'hello', kind: 'nonsense' })).toEqual({ ok: false, reason: 'invalid_kind' });
    expect(await memory.remember(A, { text: 'my friend Sam', kind: 'person', role: 'learner' })).toEqual({ ok: false, reason: 'kind_not_allowed' });
    expect((await memory.remember(A, { text: 'my friend Sam', kind: 'person', role: 'coach' })).ok).toBe(true);
    expect(store.size()).toBe(1);
  });

  test('reads the kind and importance other models send: capitals, aliases, accents, text numbers, decimals', async () => {
    const { memory } = setup({ kindAliases: { objectif: 'goal', 'préférence': 'preference' } });
    const r1 = await memory.remember(A, { text: 'Run a marathon', kind: 'GOAL', importance: '4' });
    const r2 = await memory.remember(A, { text: 'Wants to learn chess', kind: 'Objectif', importance: 4.6 });
    const r3 = await memory.remember(A, { text: 'Likes tea', kind: 'PREFERENCE', importance: 9 });
    const r4 = await memory.remember(A, { text: 'Likes coffee', kind: 'preference', importance: 'lots' });
    expect([r1, r2, r3, r4].map((r) => [r.memory.kind, r.memory.importance])).toEqual([
      ['goal', 4], ['goal', 5], ['preference', 5], ['preference', 3]
    ]);
  });

  test('defaultKind catches an unknown kind only when configured', async () => {
    const { memory } = setup({ defaultKind: 'fact' });
    expect((await memory.remember(A, { text: 'Something', kind: 'weird' })).memory.kind).toBe('fact');
    expect(() => createMemory({ store: createMemoryStore(), defaultKind: 'nope' })).toThrow(MemoryError);
  });

  test('content rules are injected; explicit requests pass a rule that allows them; roles narrow a rule', async () => {
    const rules = [
      patternRule({ code: 'secret', patterns: [/password/i] }),
      patternRule({ code: 'sensitive', patterns: [/\bsante\b/], exceptRoles: ['learner'], allowWhenExplicit: true }),
      patternRule({ code: 'off_topic', patterns: [/\bsante\b/], roles: ['learner'] })
    ];
    const { memory } = setup({ rules });
    expect(await memory.remember(A, { text: 'My password is hunter2', kind: 'fact', explicit: true })).toEqual({ ok: false, reason: 'secret' });
    expect(await memory.remember(A, { text: 'Détail de santé', kind: 'fact', role: 'coach' })).toEqual({ ok: false, reason: 'sensitive' });
    expect((await memory.remember(A, { text: 'Détail de santé', kind: 'fact', role: 'coach', explicit: true })).ok).toBe(true);
    expect(await memory.remember(B, { text: 'Détail de santé', kind: 'fact', role: 'learner', explicit: true })).toEqual({ ok: false, reason: 'off_topic' });
  });

  test('refuses the name of somebody else, whole words only, and allows the person\'s own name', async () => {
    const { memory } = setup({ namesOf: async () => ['José Ortega', 'Paul', 'Al'] });
    expect(await memory.remember(A, { text: 'Helps jose ORTEGA with reading', kind: 'fact' })).toEqual({ ok: false, reason: 'other_person' });
    expect((await memory.remember(A, { text: 'Works with Pauline', kind: 'fact' })).ok).toBe(true);
    expect((await memory.remember(A, { text: 'Al is short', kind: 'fact' })).ok).toBe(true);
    expect((await memory.remember(A, { text: 'José Ortega teaches year 6', kind: 'fact', personName: 'Jose Ortega' })).ok).toBe(true);
  });

  test('a paused memory writes nothing', async () => {
    const { memory, store } = setup();
    await memory.setPaused(A, true);
    expect(await memory.remember(A, { text: 'Likes tea', kind: 'preference' })).toEqual({ ok: false, reason: 'paused' });
    expect(store.size()).toBe(0);
    expect((await memory.remember(B, { text: 'Likes tea', kind: 'preference' })).ok).toBe(true);
  });

  test('a near-duplicate meaning replaces the older memory; undo brings it back', async () => {
    const { memory } = setup({ embed: async (text) => ({ vector: topicEmbed(text), source: 'm1' }) });
    const first = await memory.remember(A, { text: 'Plays violin', kind: 'fact' });
    const second = await memory.remember(A, { text: 'Practises the violin daily', kind: 'fact' });
    expect(second.supersededId).toBe(first.memory.id);
    expect((await memory.list(A)).map((m) => m.text)).toEqual(['Practises the violin daily']);
    expect(await memory.undo(A, second.memory.id)).toBe(true);
    expect((await memory.list(A)).map((m) => m.text)).toEqual(['Plays violin']);
  });

  test('two embedding sources are never compared; the same words are a duplicate even without vectors', async () => {
    let source = 'm1';
    const { memory } = setup({ embed: async (text) => ({ vector: topicEmbed(text), source }) });
    await memory.remember(A, { text: 'Plays violin', kind: 'fact' });
    source = 'm2';
    const other = await memory.remember(A, { text: 'Practises the violin daily', kind: 'fact' });
    expect(other.supersededId).toBeNull();
    const plain = setup();
    const x = await plain.memory.remember(A, { text: 'Likes Tea!', kind: 'preference' });
    const y = await plain.memory.remember(A, { text: 'likes tea', kind: 'preference' });
    expect(y.supersededId).toBe(x.memory.id);
  });

  test('a failing embedding keeps the memory without a vector, and reindex fills it later', async () => {
    let up = false;
    const { memory } = setup({ embed: async (text) => { if (!up) throw new Error('down'); return { vector: topicEmbed(text), source: 'm1' }; } });
    const kept = await memory.remember(A, { text: 'Loves math', kind: 'preference' });
    expect(kept.ok).toBe(true);
    expect(kept.memory.hasVector).toBe(false);
    expect(await memory.reindex()).toEqual({ updated: 0, failed: 1 });
    up = true;
    expect(await memory.reindex()).toEqual({ updated: 1, failed: 0 });
    expect((await memory.get(A, kept.memory.id)).hasVector).toBe(true);
  });

  test('reindex with a source re-embeds vectors from another model', async () => {
    let source = 'old';
    const { memory, store } = setup({ embed: async (text) => ({ vector: topicEmbed(text), source }) });
    const kept = await memory.remember(A, { text: 'Loves math', kind: 'preference' });
    source = 'new';
    expect(await memory.reindex({ source: 'new' })).toEqual({ updated: 1, failed: 0 });
    expect((await store.get(A, kept.memory.id)).vectorSource).toBe('new');
  });

  test('the text given to embeddings goes through mask first', async () => {
    const seen = [];
    const { memory } = setup({
      mask: async (text) => text.replace('José', '[PERSON]'),
      embed: async (text) => { seen.push(text); return [1, 0]; }
    });
    await memory.remember(A, { text: 'Tutors José', kind: 'fact' });
    expect(seen).toEqual(['Tutors [PERSON]']);
  });

  test('the cap removes the least important, then the longest unused', async () => {
    const { memory } = setup({ maxActive: 2 });
    await memory.remember(A, { text: 'Important old', kind: 'fact', importance: 5 });
    await memory.remember(A, { text: 'Minor', kind: 'fact', importance: 1 });
    await memory.remember(A, { text: 'Useful new', kind: 'fact', importance: 3 });
    expect((await memory.list(A)).map((m) => m.text).sort()).toEqual(['Important old', 'Useful new']);
  });
});

describe('encryption', () => {
  const cipher = {
    encrypt: async (text) => `enc:${Buffer.from(text).toString('base64')}`,
    decrypt: async (value) => Buffer.from(String(value).slice(4), 'base64').toString()
  };

  test('the store only ever holds ciphertext; reads and recall see clear text', async () => {
    const { memory, store } = setup({ cipher });
    const kept = await memory.remember(A, { text: 'Loves the garden', kind: 'preference' });
    expect((await store.get(A, kept.memory.id)).text).not.toContain('garden');
    expect(kept.memory.text).toBe('Loves the garden');
    expect((await memory.recall(A, { query: 'garden' })).map((m) => m.text)).toEqual(['Loves the garden']);
    const dup = await memory.remember(A, { text: 'loves the garden', kind: 'preference' });
    expect(dup.supersededId).toBe(kept.memory.id);
  });

  test('an encrypt that returns the text unchanged refuses to store it in clear', async () => {
    const { memory, store } = setup({ cipher: { encrypt: (t) => t, decrypt: (t) => t } });
    await expect(memory.remember(A, { text: 'Likes tea', kind: 'preference' })).rejects.toMatchObject({ code: 'encryption_unavailable' });
    expect(store.size()).toBe(0);
  });
});

describe('update', () => {
  test('a correction is a new version: the old one is kept behind it and undo restores it', async () => {
    const { memory } = setup();
    const kept = await memory.remember(A, { text: 'Trains on Saturday', kind: 'fact', importance: 4 });
    const fixed = await memory.update(A, kept.memory.id, { text: 'Trains on Sunday' });
    expect(fixed).toMatchObject({ ok: true, supersededId: kept.memory.id });
    expect(fixed.memory).toMatchObject({ text: 'Trains on Sunday', kind: 'fact', importance: 4 });
    expect(await memory.get(A, kept.memory.id)).toBeNull();
    expect(await memory.undo(A, fixed.memory.id)).toBe(true);
    expect((await memory.list(A)).map((m) => m.text)).toEqual(['Trains on Saturday']);
  });

  test('a name the memory already carried stays allowed; a new name is refused; the person\'s own name is allowed', async () => {
    const { memory } = setup({ namesOf: async () => ['José Ortega', 'Dana Reyes'] });
    const store = memory;
    const withName = await store.remember(A, { text: 'Follows José Ortega in reading', kind: 'fact', personName: 'José Ortega' });
    expect(withName.ok).toBe(true);
    const edited = await store.update(A, withName.memory.id, { text: 'Follows José Ortega in reading and maths' });
    expect(edited.ok).toBe(true);
    const plain = await store.remember(A, { text: 'Likes maps', kind: 'preference' });
    expect(await store.update(A, plain.memory.id, { text: 'Likes maps, like José Ortega' })).toEqual({ ok: false, reason: 'other_person' });
    const own = await store.update(A, plain.memory.id, { text: 'Dana Reyes likes maps' }, { personName: 'Dana Reyes' });
    expect(own.ok).toBe(true);
  });

  test('kind and importance stay unless given; the rules still apply with the memory\'s role', async () => {
    const { memory } = setup({ roleKinds: { learner: ['goal', 'fact'] } });
    const kept = await memory.remember(A, { text: 'Aims for a distinction', kind: 'goal', importance: 5, role: 'learner' });
    const same = await memory.update(A, kept.memory.id, { text: 'Aims for a high distinction' });
    expect(same.memory).toMatchObject({ kind: 'goal', importance: 5, role: 'learner' });
    expect(await memory.update(A, same.memory.id, { kind: 'person' })).toEqual({ ok: false, reason: 'kind_not_allowed' });
    const unchanged = await memory.update(A, same.memory.id, { text: 'Aims for a high distinction' });
    expect(unchanged).toMatchObject({ ok: true, unchanged: true, supersededId: null });
  });

  test('another owner, a superseded version or an unknown id is not found', async () => {
    const { memory } = setup();
    const kept = await memory.remember(A, { text: 'Likes tea', kind: 'preference' });
    expect(await memory.update(B, kept.memory.id, { text: 'hacked' })).toEqual({ ok: false, reason: 'not_found' });
    const fixed = await memory.update(A, kept.memory.id, { text: 'Likes green tea' });
    expect(await memory.update(A, kept.memory.id, { text: 'again' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await memory.update(A, 'nope', { text: 'x' })).toEqual({ ok: false, reason: 'not_found' });
    expect(fixed.ok).toBe(true);
  });

  test('a concurrent change is reported as a conflict and leaves no orphan', async () => {
    const store = createMemoryStore();
    const realUpdate = store.update;
    const { memory } = setup({ store });
    const kept = await memory.remember(A, { text: 'Likes tea', kind: 'preference' });
    store.update = async (where, id, patch, opts) => (patch.supersededBy ? null : realUpdate(where, id, patch, opts));
    expect(await memory.update(A, kept.memory.id, { text: 'Likes coffee' })).toEqual({ ok: false, reason: 'conflict' });
    store.update = realUpdate;
    expect((await memory.list(A)).map((m) => m.text)).toEqual(['Likes tea']);
    expect(store.size()).toBe(1);
  });
});

describe('forget, erase, purge', () => {
  test('forget erases the memory and every earlier version of it', async () => {
    const { memory, store } = setup();
    const kept = await memory.remember(A, { text: 'Lives in Lyon', kind: 'fact' });
    const v2 = await memory.update(A, kept.memory.id, { text: 'Lives in Paris' });
    const v3 = await memory.update(A, v2.memory.id, { text: 'Lives in Nantes' });
    expect(store.size()).toBe(3);
    expect(await memory.forget(A, v3.memory.id)).toBe(true);
    expect(store.size()).toBe(0);
  });

  test('forget and eraseAll stay within their owner and scope', async () => {
    const { memory } = setup();
    const mine = await memory.remember(A, { text: 'Likes tea', kind: 'preference' });
    await memory.remember(B, { text: 'Likes tea', kind: 'preference' });
    await memory.remember({ ownerId: 'alice', scope: 'team-2' }, { text: 'Likes tea', kind: 'preference' });
    expect(await memory.forget(B, mine.memory.id)).toBe(false);
    expect(await memory.eraseAll(A)).toBe(1);
    expect(await memory.list(B)).toHaveLength(1);
    expect(await memory.list({ ownerId: 'alice', scope: 'team-2' })).toHaveLength(1);
  });

  test('purgeOwner erases one person in every scope, settings included', async () => {
    const { memory } = setup();
    await memory.remember(A, { text: 'Likes tea', kind: 'preference' });
    await memory.remember({ ownerId: 'alice', scope: 'team-2' }, { text: 'Likes tea', kind: 'preference' });
    await memory.remember(B, { text: 'Likes tea', kind: 'preference' });
    await memory.setPaused(A, true);
    const counts = await memory.purgeOwner('alice');
    expect(counts).toMatchObject({ memories: 2, settings: 1 });
    expect(await memory.isPaused(A)).toBe(false);
    expect(await memory.list(B)).toHaveLength(1);
    await expect(memory.purgeOwner('')).rejects.toMatchObject({ code: 'invalid_where' });
  });

  test('an operation without an owner throws instead of touching everybody', async () => {
    const { memory } = setup();
    await expect(memory.list({ scope: 'team-1' })).rejects.toMatchObject({ code: 'invalid_where' });
    await expect(memory.eraseAll({})).rejects.toBeInstanceOf(MemoryError);
    await expect(memory.remember(null, { text: 'x', kind: 'fact' })).rejects.toBeInstanceOf(MemoryError);
  });
});

describe('recall', () => {
  test('hybrid: meaning and words fused, owner-bound, and found memories are marked used', async () => {
    const { memory } = setup({ embed: async (text) => ({ vector: topicEmbed(text), source: 'm1' }) });
    await memory.remember(A, { text: 'Plays violin in an orchestra', kind: 'fact' });
    await memory.remember(A, { text: 'Grows tomatoes in the garden', kind: 'fact' });
    await memory.remember(B, { text: 'Plays violin too', kind: 'fact' });
    const found = await memory.recall(A, { query: 'violin' });
    expect(found[0].text).toBe('Plays violin in an orchestra');
    expect(found.every((m) => m.ownerId === 'alice')).toBe(true);
    expect(found[0].lastUsedAt).toBeInstanceOf(Date);
    expect((await memory.get(A, found[0].id)).lastUsedAt).toEqual(found[0].lastUsedAt);
  });

  test('minSimilarity drops weak meaning matches', async () => {
    const { memory } = setup({ embed: async (text) => ({ vector: topicEmbed(text), source: 'm1' }), minSimilarity: 0.5 });
    await memory.remember(A, { text: 'Grows tomatoes in the garden', kind: 'fact' });
    expect(await memory.recall(A, { query: 'violin' })).toEqual([]);
  });

  test('without embeddings it ranks by words, then recency, accents folded', async () => {
    const { memory } = setup();
    await memory.remember(A, { text: 'Préfère les cartes visuelles', kind: 'preference' });
    await memory.remember(A, { text: 'Aime les cartes routières', kind: 'preference' });
    await memory.remember(A, { text: 'Joue au tennis', kind: 'fact' });
    const tie = await memory.recall(A, { query: 'cartes' });
    expect(tie[0].text).toBe('Aime les cartes routières');
    const found = await memory.recall(A, { query: 'cartes visuelles prefere' });
    expect(found.map((m) => m.text)).toEqual(['Préfère les cartes visuelles', 'Aime les cartes routières']);
  });

  test('without the store\'s search the service ranks by itself, with the same results', async () => {
    const store = createMemoryStore();
    delete store.search;
    const { memory } = setup({ store, embed: async (text) => ({ vector: topicEmbed(text), source: 'm1' }) });
    await memory.remember(A, { text: 'Plays violin', kind: 'fact' });
    await memory.remember(A, { text: 'Grows tomatoes in the garden', kind: 'goal' });
    expect((await memory.recall(A, { query: 'garden', kinds: ['goal'] })).map((m) => m.text)).toEqual(['Grows tomatoes in the garden']);
    expect(await memory.recall(A, { query: 'garden', kinds: ['event'] })).toEqual([]);
  });

  test('filters by kind and dates, clamps the limit, and rejects a bad date', async () => {
    const { memory } = setup();
    for (let i = 0; i < 25; i += 1) await memory.remember(A, { text: `travel note number ${i}`, kind: i % 2 ? 'event' : 'fact' });
    expect(await memory.recall(A, { query: 'travel', limit: 100 })).toHaveLength(20);
    expect((await memory.recall(A, { query: 'travel', kinds: ['EVENT'] })).every((m) => m.kind === 'event')).toBe(true);
    expect(await memory.recall(A, { query: 'travel', after: '2999-01-01' })).toEqual([]);
    await expect(memory.recall(A, { query: 'travel', before: 'not a date' })).rejects.toMatchObject({ code: 'invalid_before' });
    expect(await memory.recall(A, { query: '   ' })).toEqual([]);
  });
});

describe('portrait, unseen, pause', () => {
  test('portrait: important memories, most recently useful first, cut on a whole line', async () => {
    const { memory } = setup();
    await memory.remember(A, { text: 'Minor detail', kind: 'fact', importance: 2 });
    await memory.remember(A, { text: 'Wants to become a doctor', kind: 'goal', importance: 5 });
    await memory.remember(A, { text: 'Prefers short answers', kind: 'preference', importance: 4 });
    await memory.recall(A, { query: 'short answers' });
    expect(await memory.portrait(A)).toBe('- Prefers short answers\n- Wants to become a doctor');
    expect(await memory.portrait(A, { maxLength: 30 })).toBe('- Prefers short answers');
    const masked = setup({ mask: (text) => text.replace('doctor', '[JOB]') });
    await masked.memory.remember(A, { text: 'Wants to become a doctor', kind: 'goal', importance: 5 });
    expect(await masked.memory.portrait(A, { masked: true })).toBe('- Wants to become a [JOB]');
  });

  test('background memories are unseen until marked; marking is owner-bound', async () => {
    const { memory } = setup();
    const learnt = await memory.remember(A, { text: 'Likes tea', kind: 'preference', channel: 'background' });
    await memory.remember(A, { text: 'Likes cake', kind: 'preference' });
    expect((await memory.listUnseen(A)).map((m) => m.text)).toEqual(['Likes tea']);
    expect(await memory.markSeen(B, [learnt.memory.id])).toBe(0);
    expect(await memory.markSeen(A, [learnt.memory.id, learnt.memory.id])).toBe(1);
    expect(await memory.listUnseen(A)).toEqual([]);
  });
});
