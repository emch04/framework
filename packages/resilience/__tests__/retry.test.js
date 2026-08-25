const { retry, defaultShouldRetry } = require('../src');

const instantly = { sleep: async () => {}, random: () => 0.5 };

describe('retry', () => {
  test('a success on the first try retries nothing', async () => {
    let calls = 0;

    expect(await retry(async () => { calls += 1; return 'ok'; }, instantly)).toBe('ok');
    expect(calls).toBe(1);
  });

  test('a transient failure is retried until it works', async () => {
    let calls = 0;

    const result = await retry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('timeout');
      return 'ok';
    }, { ...instantly, attempts: 3 });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('when every attempt fails, the LAST error surfaces', async () => {
    let calls = 0;

    await expect(retry(async () => { calls += 1; throw new Error(`échec ${calls}`); }, { ...instantly, attempts: 3 }))
      .rejects.toThrow('échec 3');
    expect(calls).toBe(3);
  });

  test('a client error is NOT retried — the request is wrong, repetition will not right it', async () => {
    let calls = 0;
    const badRequest = async () => { calls += 1; const e = new Error('invalide'); e.statusCode = 400; throw e; };

    await expect(retry(badRequest, { ...instantly, attempts: 5 })).rejects.toThrow('invalide');
    expect(calls).toBe(1);
  });

  test('a 500 IS retried — the server may recover', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) { const e = new Error('boom'); e.statusCode = 503; throw e; }
      return 'ok';
    };

    expect(await retry(flaky, { ...instantly, attempts: 3 })).toBe('ok');
  });

  test('the backoff grows and stays under the ceiling', async () => {
    const delays = [];
    await retry(async () => { throw new Error('down'); }, {
      attempts: 5, baseDelayMs: 100, maxDelayMs: 500,
      sleep: async (ms) => delays.push(ms),
      random: () => 1
    }).catch(() => {});

    expect(delays).toEqual([100, 200, 400, 500]);
  });

  test('the jitter spreads the delays — clients must not retry in synchronised waves', async () => {
    const delays = [];
    await retry(async () => { throw new Error('down'); }, {
      attempts: 3, baseDelayMs: 1000,
      sleep: async (ms) => delays.push(ms),
      random: () => 0.25
    }).catch(() => {});

    expect(delays).toEqual([250, 500]);
  });

  test('onRetry reports each failure, its attempt and its delay', async () => {
    const seen = [];
    await retry(async () => { throw new Error('down'); }, {
      ...instantly, attempts: 3,
      onRetry: (error, attempt, delayMs) => seen.push({ message: error.message, attempt, delayMs })
    }).catch(() => {});

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ message: 'down', attempt: 1 });
  });

  test('shouldRetry can protect the non-idempotent — retried once, then surfaced', async () => {
    let calls = 0;

    await expect(retry(async () => { calls += 1; throw new Error('timeout'); }, {
      ...instantly, attempts: 5, shouldRetry: (_e, attempt) => attempt < 2
    })).rejects.toThrow('timeout');
    expect(calls).toBe(2);
  });

  test('defaultShouldRetry: below 500 no, 500 and up yes, no status yes', () => {
    const withStatus = (statusCode) => Object.assign(new Error('e'), { statusCode });

    expect(defaultShouldRetry(withStatus(400))).toBe(false);
    expect(defaultShouldRetry(withStatus(404))).toBe(false);
    expect(defaultShouldRetry(withStatus(500))).toBe(true);
    expect(defaultShouldRetry(withStatus(503))).toBe(true);
    expect(defaultShouldRetry(new Error('timeout'))).toBe(true);
  });
});
