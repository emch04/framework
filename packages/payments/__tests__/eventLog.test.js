const { createMemoryEventLog } = require('../src');

describe('memory event log', () => {
  test('remembers what it has recorded', async () => {
    const log = createMemoryEventLog();

    expect(await log.seen('evt_1')).toBe(false);
    await log.record('evt_1');
    expect(await log.seen('evt_1')).toBe(true);
  });

  test('does not confuse two events', async () => {
    const log = createMemoryEventLog();
    await log.record('evt_1');

    expect(await log.seen('evt_2')).toBe(false);
  });

  test('a numeric id and its string form are the same event', async () => {
    const log = createMemoryEventLog();
    await log.record(42);

    expect(await log.seen('42')).toBe(true);
  });

  test('forgets the oldest rather than growing without end', async () => {
    const log = createMemoryEventLog({ limit: 3 });

    for (const id of ['a', 'b', 'c', 'd']) await log.record(id);

    expect(log.size()).toBe(3);
    expect(await log.seen('a')).toBe(false);
    expect(await log.seen('d')).toBe(true);
  });

  test('recording twice keeps one entry', async () => {
    const log = createMemoryEventLog();
    await log.record('evt_1');
    await log.record('evt_1');

    expect(log.size()).toBe(1);
  });

  test('claim reserves an event once, atomically', async () => {
    const log = createMemoryEventLog();

    const results = await Promise.all([log.claim('evt_1'), log.claim('evt_1')]);

    expect(results.sort()).toEqual([false, true]);
    expect(await log.claim('evt_1')).toBe(false);
  });

  test('release frees a claim so the event can be handled again', async () => {
    const log = createMemoryEventLog();
    await log.claim('evt_1');
    await log.release('evt_1');

    expect(await log.seen('evt_1')).toBe(false);
    expect(await log.claim('evt_1')).toBe(true);
  });

  test('release never undoes an event already recorded as handled', async () => {
    const log = createMemoryEventLog();
    await log.claim('evt_1');
    await log.record('evt_1');
    await log.release('evt_1');

    expect(await log.claim('evt_1')).toBe(false);
  });

  test('a claim abandoned by a crashed process expires; a handled event never does', async () => {
    let now = 0;
    const log = createMemoryEventLog({ claimTtlMs: 1000, now: () => now });
    await log.claim('stuck');
    await log.claim('done');
    await log.record('done');

    now = 999;
    expect(await log.claim('stuck')).toBe(false);
    now = 2500;
    expect(await log.claim('stuck')).toBe(true);
    expect(await log.claim('done')).toBe(false);
  });

  test('a claimed but unfinished event is not yet "seen"', async () => {
    const log = createMemoryEventLog();
    await log.claim('evt_1');

    expect(await log.seen('evt_1')).toBe(false);
  });
});
