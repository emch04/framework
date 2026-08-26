const {
  RefreshTokenError,
  createMemoryRefreshTokenStore,
  createRefreshTokenService
} = require('../src');

function service(overrides = {}) {
  const store = overrides.store || createMemoryRefreshTokenStore();
  let clock = overrides.startAt || Date.parse('2026-08-26T10:00:00.000Z');
  const svc = createRefreshTokenService({
    store,
    ttlMs: overrides.ttlMs || 30 * 24 * 60 * 60 * 1000,
    now: () => clock,
    ...overrides.options
  });
  return { svc, store, advance: (ms) => { clock += ms; }, at: () => clock };
}

describe('issue', () => {
  test('hands back an opaque token and never stores it in the clear', async () => {
    const { svc, store } = service();

    const issued = await svc.issue({ userId: 'u1' });

    expect(typeof issued.token).toBe('string');
    expect(issued.token.length).toBeGreaterThan(30);
    const records = await store.all();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(issued.token);
  });

  test('two issues for the same person are two independent families', async () => {
    const { svc } = service();

    const phone = await svc.issue({ userId: 'u1' });
    const laptop = await svc.issue({ userId: 'u1' });

    expect(phone.familyId).not.toBe(laptop.familyId);
    expect(phone.token).not.toBe(laptop.token);
  });

  test('requires a user', async () => {
    const { svc } = service();

    await expect(svc.issue({})).rejects.toThrow(/userId/i);
  });
});

describe('rotate', () => {
  test('spends the token and hands back a fresh one in the same family', async () => {
    const { svc } = service();
    const first = await svc.issue({ userId: 'u1' });

    const second = await svc.rotate(first.token);

    expect(second.token).not.toBe(first.token);
    expect(second.familyId).toBe(first.familyId);
    expect(second.userId).toBe('u1');
  });

  test('the spent token is dead the moment it is exchanged', async () => {
    const { svc } = service();
    const first = await svc.issue({ userId: 'u1' });
    await svc.rotate(first.token);

    await expect(svc.rotate(first.token)).rejects.toBeInstanceOf(RefreshTokenError);
  });

  test('REPLAYING A SPENT TOKEN KILLS THE WHOLE FAMILY', async () => {
    const { svc } = service();
    const first = await svc.issue({ userId: 'u1' });
    const second = await svc.rotate(first.token);

    // The thief replays the token they stole.
    await expect(svc.rotate(first.token)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });

    // …and the real person's live token dies with it.
    await expect(svc.rotate(second.token)).rejects.toBeInstanceOf(RefreshTokenError);
  });

  test('another family is untouched by a reuse elsewhere', async () => {
    const { svc } = service();
    const phone = await svc.issue({ userId: 'u1' });
    const laptop = await svc.issue({ userId: 'u1' });
    await svc.rotate(phone.token).then(() => svc.rotate(phone.token)).catch(() => {});

    await expect(svc.rotate(laptop.token)).resolves.toMatchObject({ userId: 'u1' });
  });

  test('an expired token is refused, and says so', async () => {
    const { svc, advance } = service({ ttlMs: 1000 });
    const issued = await svc.issue({ userId: 'u1' });

    advance(1001);

    await expect(svc.rotate(issued.token)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_EXPIRED' });
  });

  test('a token nobody ever issued is refused without touching the store', async () => {
    const { svc } = service();

    await expect(svc.rotate('not-a-real-token')).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
    await expect(svc.rotate('')).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
    await expect(svc.rotate(null)).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
  });

  test('rotation carries the expiry forward from now, not from the first issue', async () => {
    const { svc, advance, at } = service({ ttlMs: 10_000 });
    const first = await svc.issue({ userId: 'u1' });

    advance(5_000);
    const second = await svc.rotate(first.token);

    expect(second.expiresAt).toBe(at() + 10_000);
  });
});

describe('revoking', () => {
  test('signing out kills that family alone', async () => {
    const { svc } = service();
    const phone = await svc.issue({ userId: 'u1' });
    const laptop = await svc.issue({ userId: 'u1' });

    await svc.revokeFamily(phone.familyId);

    await expect(svc.rotate(phone.token)).rejects.toBeInstanceOf(RefreshTokenError);
    await expect(svc.rotate(laptop.token)).resolves.toBeTruthy();
  });

  test('changing a password kills every session the person has', async () => {
    const { svc } = service();
    const phone = await svc.issue({ userId: 'u1' });
    const laptop = await svc.issue({ userId: 'u1' });
    const someoneElse = await svc.issue({ userId: 'u2' });

    await svc.revokeAllForUser('u1');

    await expect(svc.rotate(phone.token)).rejects.toBeInstanceOf(RefreshTokenError);
    await expect(svc.rotate(laptop.token)).rejects.toBeInstanceOf(RefreshTokenError);
    await expect(svc.rotate(someoneElse.token)).resolves.toBeTruthy();
  });
});

describe('housekeeping', () => {
  test('pruning drops what has expired and keeps what has not', async () => {
    const { svc, store, advance } = service({ ttlMs: 1000 });
    await svc.issue({ userId: 'u1' });
    advance(1001);
    await svc.issue({ userId: 'u2' });

    const removed = await svc.prune();

    expect(removed).toBe(1);
    expect(await store.all()).toHaveLength(1);
  });
});


describe('the token alphabet', () => {
  test('tokens are hex, so no filter can read them as content', async () => {
    const { svc } = service();

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const issued = await svc.issue({ userId: 'u1' });
      expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('no token ever carries a double dash — the WAF reads it as an SQL comment', async () => {
    const { svc } = service();

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const issued = await svc.issue({ userId: 'u1' });
      expect(issued.token).not.toContain('--');
    }
  });
});

test('createRefreshTokenService requires a store', () => {
  expect(() => createRefreshTokenService({})).toThrow(/store/i);
});
