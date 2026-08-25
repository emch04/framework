const { createSessionClient, SessionExpiredError } = require('../src');

const authError = () => Object.assign(new Error('Unauthorized'), { status: 401 });

function build({ failFirst = 0, refreshFails = false } = {}) {
  const calls = [];
  let failures = failFirst;
  let refreshes = 0;
  const expired = [];

  const client = createSessionClient({
    request: async (path, init) => {
      calls.push({ path, init });
      if (failures > 0) { failures -= 1; throw authError(); }
      return { ok: true, path };
    },
    refresh: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (refreshFails) throw new Error('refresh token invalid');
    },
    excluded: ['/auth/refresh', '/auth/login'],
    onSessionExpired: (cause) => expired.push(cause.message)
  });

  return { client, calls, expired, refreshCount: () => refreshes };
}

describe('the happy paths', () => {
  test('a working request passes straight through', async () => {
    const { client, calls, refreshCount } = build();

    expect(await client.call('/students')).toEqual({ ok: true, path: '/students' });
    expect(calls).toHaveLength(1);
    expect(refreshCount()).toBe(0);
  });

  test('a 401 triggers a refresh, then ONE replay that succeeds', async () => {
    const { client, calls, refreshCount } = build({ failFirst: 1 });

    expect(await client.call('/students')).toEqual({ ok: true, path: '/students' });
    expect(calls.map((c) => c.path)).toEqual(['/students', '/students']);
    expect(refreshCount()).toBe(1);
  });
});

describe('the refresh stampede', () => {
  test('five simultaneous 401s spend ONE refresh, not five', async () => {
    /* Rotated refresh tokens die on first use: four racing refreshes would
       log the user out at the exact moment everything was recoverable. */
    const { client, refreshCount } = build({ failFirst: 5 });

    const results = await Promise.all([
      client.call('/a'), client.call('/b'), client.call('/c'), client.call('/d'), client.call('/e')
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(refreshCount()).toBe(1);
  });

  test('after a completed refresh, a LATER 401 may refresh again', async () => {
    const { client, refreshCount } = build({ failFirst: 1 });
    await client.call('/a');

    // The token dies again later.
    const second = build({ failFirst: 1 });
    await second.client.call('/b');

    expect(refreshCount()).toBe(1);
    expect(second.refreshCount()).toBe(1);
  });
});

describe('the infinite loop', () => {
  test('the refresh endpoint itself NEVER triggers a refresh', async () => {
    const { client, refreshCount } = build({ failFirst: 10 });

    await expect(client.call('/auth/refresh')).rejects.toMatchObject({ status: 401 });
    expect(refreshCount()).toBe(0);
  });

  test('a wrong password on login is a wrong password, not an expired session', async () => {
    const { client, refreshCount, expired } = build({ failFirst: 10 });

    await expect(client.call('/auth/login')).rejects.toMatchObject({ status: 401 });
    expect(refreshCount()).toBe(0);
    expect(expired).toHaveLength(0);
  });
});

describe('definitive expiry', () => {
  test('a failed refresh surfaces a typed error and announces the expiry once', async () => {
    const { client, expired } = build({ failFirst: 1, refreshFails: true });

    await expect(client.call('/students')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(expired).toEqual(['refresh token invalid']);
  });

  test('the original refresh failure is kept as the cause', async () => {
    const { client } = build({ failFirst: 1, refreshFails: true });

    const error = await client.call('/students').catch((e) => e);

    expect(error.code).toBe('SESSION_EXPIRED');
    expect(error.cause.message).toBe('refresh token invalid');
  });

  test('a crashing onSessionExpired handler does not mask the expiry', async () => {
    const client = createSessionClient({
      request: async () => { throw authError(); },
      refresh: async () => { throw new Error('dead'); },
      onSessionExpired: () => { throw new Error('handler crashed'); }
    });

    await expect(client.call('/x')).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe('one replay only', () => {
  test('a 401 AFTER a fresh session is a real answer — a permission, not a token', async () => {
    const { client, calls, refreshCount } = build({ failFirst: 2 });

    await expect(client.call('/admin-only')).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(2);
    expect(refreshCount()).toBe(1);
  });

  test('non-auth errors pass through untouched — a 500 is not a session problem', async () => {
    const client = createSessionClient({
      request: async () => { throw Object.assign(new Error('boom'), { status: 500 }); },
      refresh: async () => {}
    });

    await expect(client.call('/x')).rejects.toMatchObject({ status: 500 });
  });

  test('what counts as an auth error can be redefined', async () => {
    let refreshed = 0;
    const client = createSessionClient({
      request: (() => {
        let first = true;
        return async () => {
          if (first) { first = false; throw Object.assign(new Error('expired'), { code: 'TOKEN_EXPIRED' }); }
          return 'ok';
        };
      })(),
      refresh: async () => { refreshed += 1; },
      isAuthError: (error) => error.code === 'TOKEN_EXPIRED'
    });

    expect(await client.call('/x')).toBe('ok');
    expect(refreshed).toBe(1);
  });
});

describe('wiring', () => {
  test('a client without a transport or a refresh is refused up front', () => {
    expect(() => createSessionClient({ refresh: async () => {} })).toThrow(/request/);
    expect(() => createSessionClient({ request: async () => {} })).toThrow(/refresh/);
  });
});
