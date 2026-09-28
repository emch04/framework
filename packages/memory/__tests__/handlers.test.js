const { createMemoryHandlers, PRIVACY_OPERATIONS, worksWithoutAi } = require('../src');
const { setup, A, B } = require('./helpers');

describe('handlers with the AI switched off', () => {
  function build() {
    const { memory } = setup();
    const isAiEnabled = jest.fn(() => false);
    return { memory, isAiEnabled, handlers: createMemoryHandlers({ memory, isAiEnabled }) };
  }

  test('seeing, pausing, marking, taking back and erasing all keep working, without asking isAiEnabled', async () => {
    const { memory, isAiEnabled, handlers } = build();
    const a = await memory.remember(A, { text: 'Likes tea', kind: 'preference', channel: 'background' });
    const b = await memory.remember(A, { text: 'Likes cake', kind: 'preference' });
    await memory.remember(B, { text: 'Likes tea', kind: 'preference' });

    expect(await handlers.list(A)).toMatchObject({ ok: true, paused: false, memories: [{ text: 'Likes cake' }, { text: 'Likes tea' }] });
    expect((await handlers.listUnseen(A)).memories).toHaveLength(1);
    expect(await handlers.markSeen(A, { ids: [a.memory.id, 42] })).toEqual({ ok: true, seen: 1 });
    expect(await handlers.setPaused(A, { paused: true })).toEqual({ ok: true, paused: true });
    expect(await handlers.setPaused(A, { paused: 'yes' })).toEqual({ ok: true, paused: false });
    expect(await handlers.undo(A, { id: b.memory.id })).toEqual({ ok: true, undone: true });
    expect(await handlers.erase(A, { id: a.memory.id })).toEqual({ ok: true, erased: true });
    expect(await handlers.erase(A, { id: a.memory.id })).toEqual({ ok: false, reason: 'not_found' });
    expect(await handlers.eraseAll(B)).toEqual({ ok: true, erased: 1 });
    expect(await handlers.purgeOwner('alice')).toMatchObject({ ok: true, settings: 1 });
    expect(isAiEnabled).not.toHaveBeenCalled();
  });

  test('editing a memory\'s content needs the AI', async () => {
    const { memory, handlers, isAiEnabled } = build();
    const kept = await memory.remember(A, { text: 'Likes tea', kind: 'preference' });
    expect(await handlers.update(A, { id: kept.memory.id, text: 'Likes coffee' })).toEqual({ ok: false, reason: 'ai_disabled' });
    isAiEnabled.mockReturnValue(true);
    expect(await handlers.update(A, { id: kept.memory.id, text: 'Likes coffee' })).toMatchObject({ ok: true, supersededId: kept.memory.id });
  });

  test('the list of privacy operations is explicit and matches the handlers', () => {
    const { handlers } = build();
    for (const op of PRIVACY_OPERATIONS) expect(typeof handlers[op]).toBe('function');
    expect(worksWithoutAi('eraseAll')).toBe(true);
    expect(worksWithoutAi('update')).toBe(false);
  });
});
