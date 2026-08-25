const { createUnlockChallenge, createMemoryChallengeStore } = require('../src');

function build(overrides = {}) {
  const delivered = [];
  let clock = 1_000_000;
  const challenge = createUnlockChallenge({
    store: createMemoryChallengeStore(),
    deliverCode: async ({ code, subjectId }) => {
      delivered.push({ code, subjectId });
      return { sentTo: 'fo•••@example.com' };
    },
    now: () => clock,
    ...overrides
  });
  return {
    challenge,
    delivered,
    lastCode: () => delivered[delivered.length - 1].code,
    advance: (ms) => { clock += ms; }
  };
}

describe('unlock challenge', () => {
  test('a code is six digits and reaches the delivery function, not the caller', async () => {
    const { challenge, delivered } = build();

    const result = await challenge.requestCode('user-1');

    expect(delivered[0].code).toMatch(/^\d{6}$/);
    expect(result).toEqual({ sentTo: 'fo•••@example.com', expiresInMs: challenge.codeTtlMs });
    expect(JSON.stringify(result)).not.toContain(delivered[0].code);
  });

  test('the right code opens the editing window', async () => {
    const { challenge, lastCode } = build();
    await challenge.requestCode('user-1');

    const { unlockedUntil } = await challenge.verifyCode('user-1', lastCode());

    expect(unlockedUntil).toBeInstanceOf(Date);
    await expect(challenge.assertUnlocked('user-1')).resolves.toBeUndefined();
  });

  test('the window closes when it expires', async () => {
    const { challenge, lastCode, advance } = build();
    await challenge.requestCode('user-1');
    await challenge.verifyCode('user-1', lastCode());

    advance(challenge.windowMs + 1);

    expect(await challenge.unlockedUntil('user-1')).toBeNull();
    await expect(challenge.assertUnlocked('user-1')).rejects.toMatchObject({ statusCode: 403 });
  });

  test('with no code requested, nothing is unlocked', async () => {
    const { challenge } = build();

    await expect(challenge.assertUnlocked('user-1')).rejects.toMatchObject({ statusCode: 403 });
  });

  test('a wrong code is refused and counted', async () => {
    const { challenge, lastCode } = build();
    await challenge.requestCode('user-1');

    await expect(challenge.verifyCode('user-1', '000000')).rejects.toMatchObject({ statusCode: 400 });
    // The real code still works: one mistake does not burn the code.
    await expect(challenge.verifyCode('user-1', lastCode())).resolves.toBeTruthy();
  });

  test('too many attempts kill the code, and it stays dead', async () => {
    const { challenge, lastCode } = build();
    await challenge.requestCode('user-1');
    const good = lastCode();

    for (let i = 0; i < challenge.maxAttempts; i += 1) {
      await expect(challenge.verifyCode('user-1', '000000')).rejects.toMatchObject({ statusCode: 400 });
    }

    await expect(challenge.verifyCode('user-1', good)).rejects.toMatchObject({ statusCode: 429 });
    await expect(challenge.verifyCode('user-1', good)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('an expired code is refused', async () => {
    const { challenge, lastCode, advance } = build();
    await challenge.requestCode('user-1');

    advance(challenge.codeTtlMs + 1);

    await expect(challenge.verifyCode('user-1', lastCode())).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a code serves once and never again', async () => {
    const { challenge, lastCode, advance } = build();
    await challenge.requestCode('user-1');
    const code = lastCode();
    await challenge.verifyCode('user-1', code);

    advance(challenge.windowMs + 1);

    await expect(challenge.verifyCode('user-1', code)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('asking for a new code CLOSES the window already open', async () => {
    const { challenge, lastCode, advance } = build();
    await challenge.requestCode('user-1');
    await challenge.verifyCode('user-1', lastCode());
    expect(await challenge.unlockedUntil('user-1')).not.toBeNull();

    advance(challenge.resendDelayMs + 1);
    await challenge.requestCode('user-1');

    expect(await challenge.unlockedUntil('user-1')).toBeNull();
  });

  test('codes cannot be re-sent faster than the resend delay', async () => {
    const { challenge, advance } = build();
    await challenge.requestCode('user-1');

    await expect(challenge.requestCode('user-1')).rejects.toMatchObject({ statusCode: 429 });

    advance(challenge.resendDelayMs + 1);
    await expect(challenge.requestCode('user-1')).resolves.toBeTruthy();
  });

  test('two subjects never share a window', async () => {
    const { challenge, lastCode } = build();
    await challenge.requestCode('user-1');
    await challenge.verifyCode('user-1', lastCode());

    await expect(challenge.assertUnlocked('user-2')).rejects.toMatchObject({ statusCode: 403 });
  });

  test('the stored record never holds the code in the clear', async () => {
    const store = createMemoryChallengeStore();
    const { challenge, lastCode } = build({ store });
    await challenge.requestCode('user-1');

    const record = await store.find('user-1');

    expect(record.codeHash).not.toBe(lastCode());
    expect(JSON.stringify(record)).not.toContain(lastCode());
  });

  test('a delivery failure is not swallowed: a code nobody receives is a dead end', async () => {
    const { challenge } = build({ deliverCode: async () => { throw new Error('smtp down'); } });

    await expect(challenge.requestCode('user-1')).rejects.toThrow('smtp down');
  });

  test('wiring without a delivery function is refused up front', () => {
    expect(() => createUnlockChallenge({ store: createMemoryChallengeStore() }))
      .toThrow(/deliverCode/);
  });
});
