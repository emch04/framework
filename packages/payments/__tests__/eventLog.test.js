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
});
