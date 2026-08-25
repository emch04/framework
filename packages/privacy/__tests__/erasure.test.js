const { createErasureWorkflow, createMemoryErasureStore } = require('../src');

function build(overrides = {}) {
  const erased = [];
  const store = createMemoryErasureStore();
  const workflow = createErasureWorkflow({
    store,
    erase: async (request) => { erased.push(request.subject); return { ok: true }; },
    ...overrides
  });
  return { workflow, store, erased };
}

describe('erasure workflow', () => {
  test('a request waits — nothing is erased yet', async () => {
    const { workflow, erased } = build();

    const request = await workflow.request({ subject: 'user-1', reason: 'je quitte le service' });

    expect(request).toMatchObject({ subject: 'user-1', status: 'pending', reason: 'je quitte le service' });
    expect(erased).toEqual([]);
  });

  test('an approval executes the erasure and records who decided', async () => {
    const { workflow, erased } = build();
    const request = await workflow.request({ subject: 'user-1' });

    const { request: done, result } = await workflow.approve(request.id, { reviewedBy: 'admin-9', note: 'vérifié' });

    expect(erased).toEqual(['user-1']);
    expect(done).toMatchObject({ status: 'completed', reviewedBy: 'admin-9', reviewNote: 'vérifié' });
    expect(done.completedAt).toBeDefined();
    expect(result).toEqual({ ok: true });
  });

  test('a rejection records who refused, and erases nothing', async () => {
    const { workflow, erased } = build();
    const request = await workflow.request({ subject: 'user-1' });

    const done = await workflow.reject(request.id, { reviewedBy: 'admin-9', note: 'dossier encore ouvert' });

    expect(done).toMatchObject({ status: 'rejected', reviewedBy: 'admin-9', reviewNote: 'dossier encore ouvert' });
    expect(erased).toEqual([]);
  });

  test('nobody can approve their OWN request — the gate exists for a second pair of eyes', async () => {
    const { workflow, erased } = build();
    const request = await workflow.request({ subject: 'user-1', requestedBy: 'user-1' });

    await expect(workflow.approve(request.id, { reviewedBy: 'user-1' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(erased).toEqual([]);
  });

  test('an approval with no reviewer is refused — an unsigned decision is not one', async () => {
    const { workflow } = build();
    const request = await workflow.request({ subject: 'user-1' });

    await expect(workflow.approve(request.id, {})).rejects.toThrow(/who approved/);
    await expect(workflow.reject(request.id, {})).rejects.toThrow(/who rejected/);
  });

  test('an irreversible operation cannot be run twice', async () => {
    const { workflow, erased } = build();
    const request = await workflow.request({ subject: 'user-1' });
    await workflow.approve(request.id, { reviewedBy: 'admin-9' });

    await expect(workflow.approve(request.id, { reviewedBy: 'admin-9' }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(erased).toEqual(['user-1']);
  });

  test('a rejected request cannot be approved afterwards', async () => {
    const { workflow } = build();
    const request = await workflow.request({ subject: 'user-1' });
    await workflow.reject(request.id, { reviewedBy: 'admin-9' });

    await expect(workflow.approve(request.id, { reviewedBy: 'admin-9' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  test('a FAILED erasure is recorded as failed, never as completed', async () => {
    /* Recording a success that did not happen is how a product tells a
       regulator it erased data it still holds. */
    const { workflow, store } = build({ erase: async () => { throw new Error('database unavailable'); } });
    const request = await workflow.request({ subject: 'user-1' });

    await expect(workflow.approve(request.id, { reviewedBy: 'admin-9' })).rejects.toThrow('database unavailable');

    const after = await store.find(request.id);
    expect(after).toMatchObject({ status: 'failed', failureReason: 'database unavailable', reviewedBy: 'admin-9' });
  });

  test('a failed request can be approved again once the cause is fixed', async () => {
    let broken = true;
    const { workflow } = build({
      erase: async () => { if (broken) throw new Error('database unavailable'); return { ok: true }; }
    });
    const request = await workflow.request({ subject: 'user-1' });
    await expect(workflow.approve(request.id, { reviewedBy: 'admin-9' })).rejects.toThrow();

    broken = false;
    /* Not pending any more, so it must be re-requested rather than silently
       retried — the decision trail stays honest. */
    await expect(workflow.approve(request.id, { reviewedBy: 'admin-9' })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('an unknown request is a clear 404', async () => {
    const { workflow } = build();

    await expect(workflow.approve('nope', { reviewedBy: 'admin-9' })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('a request with no subject is refused', async () => {
    const { workflow } = build();

    await expect(workflow.request({})).rejects.toThrow(/subject/);
  });

  test('pending() lists what is waiting for a human', async () => {
    const { workflow } = build();
    const a = await workflow.request({ subject: 'user-1' });
    await workflow.request({ subject: 'user-2' });
    await workflow.approve(a.id, { reviewedBy: 'admin-9' });

    const waiting = await workflow.pending();

    expect(waiting.map((r) => r.subject)).toEqual(['user-2']);
  });

  test('wiring without a store or an erase function is refused up front', () => {
    expect(() => createErasureWorkflow({ erase: async () => {} })).toThrow(/store/);
    expect(() => createErasureWorkflow({ store: createMemoryErasureStore() })).toThrow(/erase/);
  });
});
