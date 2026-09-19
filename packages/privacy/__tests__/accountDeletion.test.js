const {
  createAccountDeletion,
  createMemoryDeletionStore,
  createAnonymizer,
  isDeletionDue,
  DELETION_REASONS
} = require('../src');

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-09-01T10:00:00Z');

function build(overrides = {}) {
  let clock = START.getTime();
  const erased = [];
  const suspended = [];
  const restored = [];
  const sent = [];
  const store = createMemoryDeletionStore();
  const deletion = createAccountDeletion({
    store,
    now: () => new Date(clock),
    erase: async (subject) => { erased.push(subject); },
    suspend: async (subject) => { suspended.push(subject); },
    restore: async (subject) => { restored.push(subject); },
    notify: {
      send: async (subject, message, event) => { sent.push({ subject, message, event }); return true; },
      messages: {
        scheduled: (ctx) => ({ key: 'scheduled', days: ctx.daysLeft }),
        cancelled: (ctx) => ({ key: 'cancelled', by: ctx.by }),
        reminder: (ctx) => ({ key: 'reminder', days: ctx.daysLeft }),
        erased: () => ({ key: 'erased' })
      }
    },
    ...overrides
  });
  const advance = (ms) => { clock += ms; };
  return { deletion, store, erased, suspended, restored, sent, advance };
}

describe('self-service account deletion — the request', () => {
  test('suspends at once, erases nothing, and schedules the erasure after the grace period', async () => {
    const { deletion, erased, suspended, sent } = build();

    const result = await deletion.request('user-1');

    expect(result.ok).toBe(true);
    expect(result.record.scheduledFor.getTime() - START.getTime()).toBe(30 * DAY);
    expect(suspended).toEqual(['user-1']);
    expect(erased).toEqual([]);
    expect(sent.map((s) => s.event)).toEqual(['scheduled']);
    expect(sent[0].message).toEqual({ key: 'scheduled', days: 30 });
    expect(await deletion.isSuspended('user-1')).toBe(true);
    expect(await deletion.isSuspended('user-2')).toBe(false);
  });

  test('the grace period is configurable', async () => {
    const { deletion } = build({ graceMs: 7 * DAY });

    const { record } = await deletion.request('user-1');

    expect(record.scheduledFor.getTime() - START.getTime()).toBe(7 * DAY);
  });

  test('a second request is refused WITHOUT pushing the deadline back', async () => {
    const { deletion, advance } = build();
    const first = await deletion.request('user-1');
    advance(5 * DAY);

    const second = await deletion.request('user-1');

    expect(second).toEqual({ ok: false, reason: DELETION_REASONS.ALREADY_REQUESTED });
    expect((await deletion.status('user-1')).scheduledFor).toEqual(first.record.scheduledFor);
  });

  test('two concurrent taps create one schedule, not two', async () => {
    const { deletion, suspended } = build();

    const results = await Promise.all([deletion.request('user-1'), deletion.request('user-1')]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(suspended).toEqual(['user-1']);
  });

  test('a product rule can refuse, with a reason code the client translates', async () => {
    const { deletion, suspended, store } = build({
      canRequest: async (subject, context) => (context.lastAdministrator ? 'last_manager' : null)
    });

    const refused = await deletion.request('user-1', { lastAdministrator: true });

    expect(refused).toEqual({ ok: false, reason: 'last_manager' });
    expect(suspended).toEqual([]);
    expect(store.size()).toBe(0);
    expect((await deletion.request('user-2', { lastAdministrator: false })).ok).toBe(true);
  });

  test('if the suspension fails, the request is undone — no "closed" account with live sessions', async () => {
    const { deletion, store } = build({ suspend: async () => { throw new Error('session store down'); } });

    await expect(deletion.request('user-1')).rejects.toThrow('session store down');

    expect(store.size()).toBe(0);
  });

  test('a failed confirmation e-mail does not undo the request', async () => {
    const errors = [];
    const { deletion } = build({
      notify: { send: async () => { throw new Error('smtp down'); }, messages: { scheduled: () => ({}) } },
      logger: { info() {}, error: (m) => errors.push(m) }
    });

    const result = await deletion.request('user-1');

    expect(result.ok).toBe(true);
    expect(errors.join()).toMatch(/smtp down/);
  });

  test('a request needs a subject', async () => {
    const { deletion } = build();

    await expect(deletion.request()).rejects.toThrow(/subject/);
  });
});

describe('cancellation within the grace period', () => {
  test('cancelling brings the account back and nothing is erased at the old deadline', async () => {
    const { deletion, erased, restored, sent, advance } = build();
    await deletion.request('user-1');
    advance(29 * DAY);

    expect(await deletion.cancel('user-1')).toEqual({ cancelled: true });
    advance(2 * DAY);
    const pass = await deletion.sweep();

    expect(pass.erased).toBe(0);
    expect(erased).toEqual([]);
    expect(restored).toEqual(['user-1']);
    expect(await deletion.isSuspended('user-1')).toBe(false);
    expect(sent.map((s) => s.event)).toEqual(['scheduled', 'cancelled']);
  });

  test('signing in cancels — and the owner is told, a sign-in by someone else is not silent', async () => {
    const { deletion, sent } = build();
    await deletion.request('user-1');

    expect(await deletion.onSignIn('user-1')).toEqual({ cancelled: true });
    expect(sent[1]).toMatchObject({ event: 'cancelled', message: { key: 'cancelled', by: 'sign-in' } });
  });

  test('signing in with no pending deletion writes nothing and sends nothing', async () => {
    const { deletion, sent, restored } = build();

    expect(await deletion.onSignIn('user-1')).toEqual({ cancelled: false, reason: DELETION_REASONS.NOT_FOUND });
    expect(sent).toEqual([]);
    expect(restored).toEqual([]);
  });

  test('a failure while cancelling at sign-in never locks the person out', async () => {
    const store = createMemoryDeletionStore();
    store.get = async () => { throw new Error('database unavailable'); };
    const { deletion } = build({ store });

    const result = await deletion.onSignIn('user-1');

    expect(result.cancelled).toBe(false);
    expect(result.error.message).toBe('database unavailable');
  });

  test('after the erasure there is nothing left to cancel', async () => {
    const { deletion, advance } = build();
    await deletion.request('user-1');
    advance(30 * DAY);
    await deletion.sweep();

    expect(await deletion.cancel('user-1')).toEqual({ cancelled: false, reason: DELETION_REASONS.ALREADY_ERASED });
    expect(await deletion.request('user-1')).toEqual({ ok: false, reason: DELETION_REASONS.ALREADY_ERASED });
  });

  test('a cancellation racing an erasure that has already started loses, and says so', async () => {
    let cancelDuringErase;
    const { deletion, advance } = build({
      erase: async () => { cancelDuringErase = await deletion.cancel('user-1'); }
    });
    await deletion.request('user-1');
    advance(30 * DAY);

    await deletion.sweep();

    expect(cancelDuringErase).toEqual({ cancelled: false, reason: DELETION_REASONS.ERASURE_IN_PROGRESS });
  });
});

describe('erasure only after the deadline', () => {
  test('one millisecond before the deadline, nothing is erased', async () => {
    const { deletion, erased, advance } = build();
    await deletion.request('user-1');
    advance(30 * DAY - 1);

    const pass = await deletion.sweep();

    expect(pass.erased).toBe(0);
    expect(erased).toEqual([]);
  });

  test('at the deadline, the injected erasure runs and the record says so', async () => {
    const { deletion, erased, sent, advance } = build();
    await deletion.request('user-1');
    await deletion.request('user-2');
    advance(30 * DAY);

    const pass = await deletion.sweep();

    expect(pass).toMatchObject({ ran: true, erased: 2, failed: 0 });
    expect(erased.sort()).toEqual(['user-1', 'user-2']);
    expect(await deletion.status('user-1')).toMatchObject({ erased: true, pending: false });
    expect(sent.filter((s) => s.event === 'erased')).toHaveLength(2);
  });

  test('the erasure is whatever the caller plugs in — typically this package\'s anonymizer', async () => {
    const accounts = { 'user-1': { fullName: 'Jean', email: 'jean@example.com' } };
    const anonymizer = createAnonymizer({ fields: { fullName: 'redact', email: 'clear' } });
    const { deletion, advance } = build({ erase: async (subject) => anonymizer.anonymise(accounts[subject]) });
    await deletion.request('user-1');
    advance(30 * DAY);

    await deletion.sweep();

    expect(accounts['user-1']).toEqual({ fullName: 'Anonymised', email: undefined });
  });

  test('a store adapter that returns too much still never erases early', async () => {
    /* The date filter is the adapter's job, and adapters get it wrong (a
       string compared to a Date, a missing index hint). The deadline is
       checked again here: an early erasure cannot be undone. */
    const store = createMemoryDeletionStore();
    const list = store.list;
    store.list = async (filter) => list({ status: filter.status });
    const { deletion, erased, advance } = build({ store });
    await deletion.request('user-1');
    advance(10 * DAY);

    await deletion.sweep();

    expect(erased).toEqual([]);
  });

  test('a record with no deadline is NEVER treated as due', () => {
    expect(isDeletionDue({ status: 'scheduled' }, new Date('2100-01-01'))).toBe(false);
    expect(isDeletionDue({ scheduledFor: 'not a date' }, new Date('2100-01-01'))).toBe(false);
    expect(isDeletionDue({ scheduledFor: START }, START)).toBe(true);
  });

  test('a failed erasure is retried next pass, never recorded as done', async () => {
    let broken = true;
    const { deletion, advance } = build({
      erase: async () => { if (broken) throw new Error('database unavailable'); }
    });
    await deletion.request('user-1');
    advance(30 * DAY);

    expect(await deletion.sweep()).toMatchObject({ erased: 0, failed: 1 });
    expect(await deletion.status('user-1')).toMatchObject({ erased: false, pending: true });

    broken = false;
    expect(await deletion.sweep()).toMatchObject({ erased: 1, failed: 0 });
  });

  test('one account that resists does not hold back the others', async () => {
    const { deletion, erased, advance } = build({
      erase: async (subject) => { if (subject === 'user-1') throw new Error('locked'); erased.push(subject); }
    });
    await deletion.request('user-1');
    await deletion.request('user-2');
    advance(30 * DAY);

    expect(await deletion.sweep()).toMatchObject({ erased: 1, failed: 1 });
    expect(erased).toEqual(['user-2']);
  });
});

describe('the sweep is idempotent and safe on several instances', () => {
  test('a second pass erases nothing again', async () => {
    const { deletion, erased, advance } = build();
    await deletion.request('user-1');
    advance(30 * DAY);

    await deletion.sweep();
    const again = await deletion.sweep();

    expect(again.erased).toBe(0);
    expect(erased).toEqual(['user-1']);
  });

  test('two instances sweeping at the same instant erase each account once', async () => {
    const { deletion, erased, advance } = build();
    await deletion.request('user-1');
    await deletion.request('user-2');
    advance(30 * DAY);

    await Promise.all([deletion.sweep(), deletion.sweep(), deletion.sweep()]);

    expect(erased.sort()).toEqual(['user-1', 'user-2']);
  });

  test('an injected lock held elsewhere makes the pass a no-op', async () => {
    const calls = [];
    const lock = { run: async (name, holdMs) => { calls.push({ name, holdMs }); return null; } };
    const { deletion, erased, advance } = build({ lock, lockName: 'deletions' });
    await deletion.request('user-1');
    advance(30 * DAY);

    expect(await deletion.sweep()).toMatchObject({ ran: false, erased: 0 });
    expect(erased).toEqual([]);
    expect(calls).toEqual([{ name: 'deletions', holdMs: 23 * 60 * 60 * 1000 }]);
  });

  test('a lock that grants runs the pass (createJobLock shape)', async () => {
    const lock = { run: async (_name, _hold, fn) => fn() };
    const { deletion, erased, advance } = build({ lock });
    await deletion.request('user-1');
    advance(30 * DAY);

    expect(await deletion.sweep()).toMatchObject({ ran: true, erased: 1 });
    expect(erased).toEqual(['user-1']);
  });

  test('an erasure abandoned by a dead instance is taken over once the claim is stale', async () => {
    const { deletion, store, erased, advance } = build({ staleClaimMs: 60 * 1000 });
    await deletion.request('user-1');
    advance(30 * DAY);
    /* What a crash between the claim and the end of the erasure leaves behind. */
    await store.update('user-1', { status: 'scheduled' }, { status: 'erasing', erasingSince: new Date(START.getTime() + 30 * DAY) });

    expect((await deletion.sweep()).erased).toBe(0);
    advance(61 * 1000);
    expect((await deletion.sweep()).erased).toBe(1);
    expect(erased).toEqual(['user-1']);
  });
});

describe('the last warning before the erasure', () => {
  test('goes out once per deadline, inside the reminder window only', async () => {
    const { deletion, sent, advance } = build();
    await deletion.request('user-1');

    advance(26 * DAY);
    await deletion.sweep();
    expect(sent.filter((s) => s.event === 'reminder')).toHaveLength(0);

    advance(1 * DAY + 1);
    await deletion.sweep();
    await deletion.sweep();
    const reminders = sent.filter((s) => s.event === 'reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0].message).toEqual({ key: 'reminder', days: 3 });
  });

  test('two instances in the same pass send ONE warning, not two', async () => {
    const { deletion, sent, advance } = build();
    await deletion.request('user-1');
    advance(28 * DAY);

    await Promise.all([deletion.sweep(), deletion.sweep()]);

    expect(sent.filter((s) => s.event === 'reminder')).toHaveLength(1);
  });

  test('a failed send frees the reservation for the next pass', async () => {
    let fail = true;
    const delivered = [];
    const { deletion, advance } = build({
      notify: {
        send: async (_subject, message, event) => { if (event === 'reminder' && fail) return false; delivered.push(event); return true; },
        messages: { reminder: () => ({}) }
      }
    });
    await deletion.request('user-1');
    advance(28 * DAY);

    await deletion.sweep();
    fail = false;
    await deletion.sweep();

    expect(delivered).toEqual(['reminder']);
  });

  test('a new request after a cancellation gets its own warning', async () => {
    const { deletion, sent, advance } = build();
    await deletion.request('user-1');
    advance(28 * DAY);
    await deletion.sweep();
    await deletion.cancel('user-1');
    await deletion.request('user-1');
    advance(28 * DAY);
    await deletion.sweep();

    expect(sent.filter((s) => s.event === 'reminder')).toHaveLength(2);
  });

  test('reminders can be switched off', async () => {
    const { deletion, sent, advance } = build({ reminderMs: null });
    await deletion.request('user-1');
    advance(28 * DAY);

    await deletion.sweep();

    expect(sent.filter((s) => s.event === 'reminder')).toHaveLength(0);
  });
});

describe('wiring', () => {
  test('refuses a missing store, erase, bad durations or a lock without run()', () => {
    const store = createMemoryDeletionStore();
    const erase = async () => {};
    expect(() => createAccountDeletion({ erase })).toThrow(/store/);
    expect(() => createAccountDeletion({ store })).toThrow(/erase/);
    expect(() => createAccountDeletion({ store, erase, graceMs: 0 })).toThrow(/graceMs/);
    expect(() => createAccountDeletion({ store, erase, graceMs: -1 })).toThrow(/graceMs/);
    expect(() => createAccountDeletion({ store, erase, lock: {} })).toThrow(/lock/);
    expect(() => createAccountDeletion({ store, erase, notify: {} })).toThrow(/send/);
  });

  test('status of an unknown subject is plainly "nothing pending"', async () => {
    const { deletion } = build();

    expect(await deletion.status('nobody')).toEqual({ pending: false, erased: false, requestedAt: null, scheduledFor: null });
  });
});
