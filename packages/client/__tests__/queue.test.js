const { createOfflineQueue, createMemoryQueueStore } = require('../src');

const rejection = (message) => Object.assign(new Error(message), { status: 400 });
const outage = (message) => new Error(message);

function build({ handlers, ...overrides } = {}) {
  const applied = [];
  const rejected = [];
  const store = createMemoryQueueStore();
  const queue = createOfflineQueue({
    store,
    handlers: handlers || {
      mark_attendance: async (payload) => { applied.push(payload); }
    },
    onRejected: (action, error) => rejected.push({ type: action.type, reason: error.message }),
    ...overrides
  });
  return { queue, store, applied, rejected };
}

describe('recording', () => {
  test('an offline mutation is recorded, not failed', async () => {
    const { queue, store } = build();

    await queue.enqueue('mark_attendance', { student: 's1', state: 'present' });

    expect(store.size()).toBe(1);
    expect((await queue.pending())[0]).toMatchObject({ type: 'mark_attendance' });
  });

  test('an action nobody can replay is refused NOW, not stranded forever', async () => {
    const { queue } = build();

    await expect(queue.enqueue('unknown_action', {})).rejects.toThrow(/no handler/);
  });
});

describe('replaying', () => {
  test('the queue replays IN ORDER — present then absent must land in that order', async () => {
    const { queue, applied } = build();
    await queue.enqueue('mark_attendance', { student: 's1', state: 'present' });
    await queue.enqueue('mark_attendance', { student: 's1', state: 'absent' });

    const report = await queue.replay();

    expect(applied.map((a) => a.state)).toEqual(['present', 'absent']);
    expect(report).toMatchObject({ applied: 2, remaining: 0, halted: false });
  });

  test('an applied action leaves the queue — replaying twice applies once', async () => {
    const { queue, applied } = build();
    await queue.enqueue('mark_attendance', { student: 's1' });

    await queue.replay();
    await queue.replay();

    expect(applied).toHaveLength(1);
  });

  test('an OUTAGE halts the replay — applying what is behind would reorder history', async () => {
    let networkUp = false;
    const applied = [];
    const { queue } = build({
      handlers: {
        act: async (payload) => {
          if (!networkUp) throw outage('network unreachable');
          applied.push(payload);
        }
      }
    });
    await queue.enqueue('act', { n: 1 });
    await queue.enqueue('act', { n: 2 });

    const down = await queue.replay();
    expect(down).toMatchObject({ applied: 0, halted: true, remaining: 2, error: 'network unreachable' });
    expect(applied).toEqual([]);

    /* Same place next time: nothing lost, nothing skipped. */
    networkUp = true;
    const up = await queue.replay();
    expect(up).toMatchObject({ applied: 2, halted: false, remaining: 0 });
    expect(applied.map((a) => a.n)).toEqual([1, 2]);
  });

  test('a REJECTION is set aside — one wrong action must not strand the queue forever', async () => {
    const seen = [];
    const { queue, rejected } = build({
      handlers: {
        act: async ({ n }) => {
          if (n === 1) throw rejection('duplicate entry');
          seen.push(n);
        }
      }
    });
    await queue.enqueue('act', { n: 1 });
    await queue.enqueue('act', { n: 2 });

    const report = await queue.replay();

    expect(report).toMatchObject({ applied: 1, rejected: 1, halted: false, remaining: 0 });
    expect(seen).toEqual([2]);
    /* And the user LEARNS about it — silence would mean work they believe is
       saved, is not. */
    expect(rejected).toEqual([{ type: 'act', reason: 'duplicate entry' }]);
  });

  test('an action queued under an old app version is set aside as rejected, visibly', async () => {
    const store = createMemoryQueueStore();
    const before = createOfflineQueue({ store, handlers: { old_action: async () => {} } });
    await before.enqueue('old_action', {});

    const rejected = [];
    const after = createOfflineQueue({
      store,
      handlers: { new_action: async () => {} },
      onRejected: (action, error) => rejected.push(error.message)
    });

    const report = await after.replay();

    expect(report).toMatchObject({ rejected: 1, remaining: 0 });
    expect(rejected[0]).toMatch(/no handler/);
  });

  test('two concurrent replays share ONE run — a sync event plus a manual retry apply once', async () => {
    const applied = [];
    const { queue } = build({
      handlers: {
        act: async (payload) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          applied.push(payload);
        }
      }
    });
    await queue.enqueue('act', { n: 1 });

    await Promise.all([queue.replay(), queue.replay()]);

    expect(applied).toHaveLength(1);
  });

  test('what counts as a rejection can be redefined', async () => {
    const { queue, rejected } = build({
      handlers: { act: async () => { throw Object.assign(new Error('conflit'), { code: 'CONFLICT' }); } },
      isRejection: (error) => error.code === 'CONFLICT'
    });
    await queue.enqueue('act', {});

    const report = await queue.replay();

    expect(report.rejected).toBe(1);
    expect(rejected).toHaveLength(1);
  });

  test('an empty queue replays to a clean report', async () => {
    const { queue } = build();

    expect(await queue.replay()).toMatchObject({ applied: 0, rejected: 0, halted: false, remaining: 0 });
  });
});

describe('wiring', () => {
  test('a queue without a store or handlers is refused up front', () => {
    expect(() => createOfflineQueue({ handlers: { x: async () => {} } })).toThrow(/store/);
    expect(() => createOfflineQueue({ store: createMemoryQueueStore(), handlers: {} })).toThrow(/handler/);
  });
});
