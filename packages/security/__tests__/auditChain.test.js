const { createAuditChain, createMemoryAuditStore, GENESIS_HASH, stableStringify } = require('../src');

function build(overrides = {}) {
  const store = createMemoryAuditStore();
  const chain = createAuditChain({ store, now: () => new Date('2026-08-25T10:00:00Z'), ...overrides });
  return { store, chain };
}

const fill = async (chain, count = 3) => {
  for (let i = 0; i < count; i += 1) {
    await chain.record({ type: 'action', actor: `u${i}`, message: `événement ${i}` });
  }
};

describe('recording', () => {
  test('the first entry points at nothing before it', async () => {
    const { store, chain } = build();

    await chain.record({ type: 'login', actor: 'u1', message: 'connexion' });

    expect(store.entries[0].previousHash).toBe(GENESIS_HASH);
    expect(store.entries[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('each entry points at the one before it', async () => {
    const { store, chain } = build();
    await fill(chain, 3);

    expect(store.entries[1].previousHash).toBe(store.entries[0].hash);
    expect(store.entries[2].previousHash).toBe(store.entries[1].hash);
  });

  test('two identical events still get different hashes — the chain differs', async () => {
    const { store, chain } = build();

    await chain.record({ type: 'login', actor: 'u1', message: 'connexion' });
    await chain.record({ type: 'login', actor: 'u1', message: 'connexion' });

    expect(store.entries[0].hash).not.toBe(store.entries[1].hash);
  });

  test('a failed write does NOT take down the operation it was recording', async () => {
    /* Losing the trace is bad. Losing the payment is worse. */
    const failures = [];
    const broken = { last: async () => null, append: async () => { throw new Error('database unavailable'); } };
    const chain = createAuditChain({
      store: broken,
      logger: { error: (m) => failures.push(m) },
      onRecordFailed: (error) => failures.push(`hook:${error.message}`)
    });

    await expect(chain.record({ type: 'payment' })).resolves.toBeNull();
    expect(failures.join(' ')).toMatch(/database unavailable/);
    expect(failures.some((f) => f.startsWith('hook:'))).toBe(true);
  });
});

describe('verification', () => {
  test('an untouched chain is intact', async () => {
    const { chain } = build();
    await fill(chain, 4);

    expect(await chain.verify()).toEqual({ intact: true, checked: 4 });
  });

  test('an empty chain is intact', async () => {
    const { chain } = build();

    expect(await chain.verify()).toEqual({ intact: true, checked: 0 });
  });

  test('an ALTERED entry is caught, and named as altered', async () => {
    const { store, chain } = build();
    await fill(chain, 3);

    store.entries[1].message = 'quelque chose de plus flatteur';

    const report = await chain.verify();
    expect(report.intact).toBe(false);
    expect(report.failure).toMatchObject({ reason: 'altered', index: 1 });
  });

  test('a DELETED entry is caught, and named as broken', async () => {
    /* Telling the two apart matters: altered content is a rewrite, a broken
       link means something was removed or slipped in. */
    const { store, chain } = build();
    await fill(chain, 4);

    store.entries.splice(1, 1);

    const report = await chain.verify();
    expect(report.intact).toBe(false);
    expect(report.failure).toMatchObject({ reason: 'broken', index: 1 });
  });

  test('an INSERTED entry is caught', async () => {
    const { store, chain } = build();
    await fill(chain, 3);

    store.entries.splice(1, 0, { type: 'invented', previousHash: 'x'.repeat(64), hash: 'y'.repeat(64), recordedAt: 'now' });

    expect((await chain.verify()).failure).toMatchObject({ reason: 'broken', index: 1 });
  });

  test('rewriting an entry AND its hash still breaks the chain after it', async () => {
    /* Fixing one entry's own hash is not enough: everything after it points at
       the old value. Hiding a change means rewriting the whole tail. */
    const { store, chain } = build();
    await fill(chain, 3);

    store.entries[0].message = 'autre chose';
    store.entries[0].hash = chain.hashEvent(store.entries[0]);

    const report = await chain.verify();
    expect(report.intact).toBe(false);
    expect(report.failure).toMatchObject({ reason: 'broken', index: 1 });
  });

  test('reordering two entries is caught', async () => {
    const { store, chain } = build();
    await fill(chain, 3);

    [store.entries[0], store.entries[1]] = [store.entries[1], store.entries[0]];

    expect((await chain.verify()).intact).toBe(false);
  });

  test('an extra column added later does not invalidate the chain', async () => {
    /* Only the signed fields feed the hash — a new database column, an index,
       a soft-delete flag must not read as tampering. */
    const { store, chain } = build();
    await fill(chain, 2);

    for (const entry of store.entries) entry.replicatedAt = '2026-09-01';

    expect((await chain.verify()).intact).toBe(true);
  });

  test('verify can be handed the entries directly', async () => {
    const { store, chain } = build();
    await fill(chain, 2);

    expect(await chain.verify([...store.entries])).toEqual({ intact: true, checked: 2 });
  });

  test('a store with no list() and no entries given is a wiring mistake', async () => {
    const chain = createAuditChain({ store: { last: async () => null, append: async (e) => e } });

    await expect(chain.verify()).rejects.toThrow(/list\(\)/);
  });

  test('a chain without a store is refused up front', () => {
    expect(() => createAuditChain({})).toThrow(/store\.last/);
    expect(() => createAuditChain({ store: { last: () => {} } })).toThrow(/store\.append/);
  });
});

describe('stable serialisation', () => {
  test('key order does not change the result', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  test('nested objects are sorted too', () => {
    expect(stableStringify({ x: { b: 1, a: 2 } })).toBe(stableStringify({ x: { a: 2, b: 1 } }));
  });

  test('array order IS preserved — it carries meaning', () => {
    expect(stableStringify(['a', 'b'])).not.toBe(stableStringify(['b', 'a']));
  });

  test('dates serialise the same way whoever built them', () => {
    const iso = '2026-08-25T10:00:00.000Z';

    expect(stableStringify(new Date(iso))).toBe(JSON.stringify(iso));
  });
});
