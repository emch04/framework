const { createPendingActions, createMemoryActionStore } = require('../src');

function build(overrides = {}) {
  const sent = [];
  const store = createMemoryActionStore();
  const airlock = createPendingActions({
    store,
    tools: {
      send_email: async (payload) => { sent.push(payload); return { delivered: true }; },
      delete_record: async () => ({ deleted: true })
    },
    ...overrides
  });
  return { airlock, store, sent };
}

const proposal = { action: 'send_email', payload: { to: 'famille@x.cd', body: 'Rappel' }, proposedBy: 'agent' };

describe('proposing', () => {
  test('a proposed write does NOT run', async () => {
    const { airlock, sent } = build();

    const { action } = await airlock.propose(proposal);

    expect(action.status).toBe('proposed');
    expect(sent).toHaveLength(0);
  });

  test('an action outside the tool map cannot even be proposed', async () => {
    const { airlock } = build();

    await expect(airlock.propose({ action: 'transfer_money', payload: {} }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('an insistent model cannot stack five identical proposals', async () => {
    const { airlock, store } = build();

    const first = await airlock.propose({ ...proposal, dedupeKey: 'reminder:famille@x.cd' });
    const second = await airlock.propose({ ...proposal, dedupeKey: 'reminder:famille@x.cd' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.action.id).toBe(first.action.id);
    expect(store.size()).toBe(1);
  });

  test('once handled, the same dedupe key may open a NEW action', async () => {
    const { airlock } = build();
    const first = await airlock.propose({ ...proposal, dedupeKey: 'k' });
    await airlock.reject(first.action.id, { rejectedBy: 'admin' });

    const again = await airlock.propose({ ...proposal, dedupeKey: 'k' });

    expect(again.created).toBe(true);
  });

  test('the humans are told something waits — and a dead channel does not fail the agent', async () => {
    const notified = [];
    const ok = build({ onPending: async (a) => notified.push(a.action) });
    await ok.airlock.propose(proposal);
    expect(notified).toEqual(['send_email']);

    const broken = build({ onPending: async () => { throw new Error('notification backend down'); } });
    await expect(broken.airlock.propose(proposal)).resolves.toMatchObject({ created: true });
  });
});

describe('approving', () => {
  test('an approval runs the tool, once, and records who said yes', async () => {
    const { airlock, sent } = build();
    const { action } = await airlock.propose(proposal);

    const outcome = await airlock.approve(action.id, { approvedBy: 'director-1' });

    expect(outcome.executed).toBe(true);
    expect(outcome.action).toMatchObject({ status: 'executed', approvedBy: 'director-1' });
    expect(sent).toEqual([{ to: 'famille@x.cd', body: 'Rappel' }]);
  });

  test('two simultaneous approvals produce ONE send, not two', async () => {
    const { airlock, sent } = build();
    const { action } = await airlock.propose(proposal);

    const [a, b] = await Promise.all([
      airlock.approve(action.id, { approvedBy: 'director-1' }),
      airlock.approve(action.id, { approvedBy: 'director-2' })
    ]);

    expect(sent).toHaveLength(1);
    expect([a.executed, b.executed].filter(Boolean)).toHaveLength(1);
  });

  test('an unsigned approval is refused — an unsigned decision is not one', async () => {
    const { airlock } = build();
    const { action } = await airlock.propose(proposal);

    await expect(airlock.approve(action.id, {})).rejects.toThrow(/who approved/);
  });

  test('the human can amend the payload — the model\'s draft is corrected, not trusted blindly', async () => {
    const { airlock, sent } = build();
    const { action } = await airlock.propose(proposal);

    await airlock.approve(action.id, { approvedBy: 'director-1', amend: { to: 'autre-famille@x.cd' } });

    expect(sent[0]).toEqual({ to: 'autre-famille@x.cd', body: 'Rappel' });
  });

  test('the amendment is recorded on the action', async () => {
    const { airlock, store } = build();
    const { action } = await airlock.propose(proposal);
    await airlock.approve(action.id, { approvedBy: 'd', amend: { to: 'x@y.cd' } });

    expect((await store.find(action.id)).amendedWith).toEqual({ to: 'x@y.cd' });
  });

  test('a tool that RETURNS an error is marked failed, never executed', async () => {
    /* "Sent" on screen for a message that never left is the lie this exists
       to prevent. */
    const { airlock, store } = build({
      tools: { send_email: async () => ({ error: 'aucun destinataire valide' }) }
    });
    const { action } = await airlock.propose(proposal);

    const outcome = await airlock.approve(action.id, { approvedBy: 'd' });

    expect(outcome).toMatchObject({ executed: false, reason: 'failed' });
    expect((await store.find(action.id)).status).toBe('failed');
  });

  test('a tool that throws is marked failed with the reason kept', async () => {
    const { airlock, store } = build({
      tools: { send_email: async () => { throw new Error('smtp down'); } }
    });
    const { action } = await airlock.propose(proposal);

    await airlock.approve(action.id, { approvedBy: 'd' });

    expect(await store.find(action.id)).toMatchObject({ status: 'failed', lastError: 'smtp down' });
  });

  test('an already-handled action answers 409, and does not run again', async () => {
    const { airlock, sent } = build();
    const { action } = await airlock.propose(proposal);
    await airlock.approve(action.id, { approvedBy: 'd' });

    await expect(airlock.approve(action.id, { approvedBy: 'd' })).rejects.toMatchObject({ statusCode: 409 });
    expect(sent).toHaveLength(1);
  });

  test('a tool that vanished between proposal and approval is refused', async () => {
    /* A deploy between the two, or a tampered record. */
    const store = createMemoryActionStore();
    const before = createPendingActions({ store, tools: { send_email: async () => ({}) } });
    const { action } = await before.propose(proposal);

    const after = createPendingActions({ store, tools: { delete_record: async () => ({}) } });

    await expect(after.approve(action.id, { approvedBy: 'd' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('rejecting and listing', () => {
  test('a rejection records who refused and runs nothing', async () => {
    const { airlock, sent } = build();
    const { action } = await airlock.propose(proposal);

    const rejected = await airlock.reject(action.id, { rejectedBy: 'director-1', note: 'mauvais destinataire' });

    expect(rejected).toMatchObject({ status: 'rejected', rejectedBy: 'director-1', reviewNote: 'mauvais destinataire' });
    expect(sent).toHaveLength(0);
  });

  test('pending() lists what waits for a human', async () => {
    const { airlock } = build();
    const a = await airlock.propose({ ...proposal, dedupeKey: 'a' });
    await airlock.propose({ ...proposal, dedupeKey: 'b' });
    await airlock.reject(a.action.id, { rejectedBy: 'd' });

    expect((await airlock.pending()).map((x) => x.dedupeKey)).toEqual(['b']);
  });

  test('an unknown action is a clean 404', async () => {
    const { airlock } = build();

    await expect(airlock.approve('nope', { approvedBy: 'd' })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('wiring without a store or tools is refused up front', () => {
    expect(() => createPendingActions({ tools: { x: () => {} } })).toThrow(/store/);
    expect(() => createPendingActions({ store: createMemoryActionStore(), tools: {} })).toThrow(/tool/);
  });
});
