const { createFieldCipher, generateFieldEncryptionKey } = require('@astratra/security');
const {
  BalanceProbeError,
  BALANCE_ERRORS,
  SERPER_ACCOUNT_URL,
  SERPER_THRESHOLDS,
  classifyBalance,
  createBalanceProbe,
  createCredentialCatalog,
  createCredentialVault,
  createMemoryCredentialStore,
  createSerperBalanceReader,
  serperBalanceProbe
} = require('../src');

const SECRET = 'serper-key-from-the-interface-9876';

function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = typeof answer === 'function' ? answer(calls.length) : answer;
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const json = (body, status = 200) => ({ status, json: async () => body });

describe('classifyBalance', () => {
  test.each([
    [2449, 'ok', false],
    [599, 'low', false],
    [199, 'low', true],
    [0, 'empty', true],
    [-3, 'empty', true]
  ])('%i credits read as %s (critical %s)', (balance, status, critical) => {
    expect(classifyBalance(balance, SERPER_THRESHOLDS)).toEqual({ status, critical });
  });

  test('the thresholds are exclusive: exactly at the line is still above it', () => {
    expect(classifyBalance(600, SERPER_THRESHOLDS).status).toBe('ok');
    expect(classifyBalance(200, SERPER_THRESHOLDS)).toEqual({ status: 'low', critical: false });
  });

  test('without thresholds only zero is a problem', () => {
    expect(classifyBalance(1, {})).toEqual({ status: 'ok', critical: false });
  });

  test('something that is not a number is never classified as a balance', () => {
    expect(classifyBalance('2449', SERPER_THRESHOLDS).status).toBe('error');
    expect(classifyBalance(Number.NaN).status).toBe('error');
  });
});

describe('createBalanceProbe', () => {
  function build({ value = SECRET, read, thresholds = SERPER_THRESHOLDS, clock, ...rest } = {}) {
    const values = { SERPER_API_KEY: value };
    const reads = [];
    let time = clock || 1_000_000;
    const logged = [];
    const probe = createBalanceProbe({
      getValue: async (key) => values[key],
      probes: {
        SERPER_API_KEY: {
          read: async (key, context) => { reads.push({ key, context }); return read ? read(reads.length) : { balance: 2449, rateLimit: 5 }; },
          thresholds,
          unit: 'credits',
          renewable: false
        }
      },
      now: () => time,
      logger: { warn: (line) => logged.push(line) },
      ...rest
    });
    return { probe, reads, values, logged, advance: (ms) => { time += ms; } };
  }

  test('reports the balance, its status and what the provider says about its rate', async () => {
    const { probe } = build();
    const report = await probe.check('SERPER_API_KEY');
    expect(report).toMatchObject({
      key: 'SERPER_API_KEY', status: 'ok', critical: false, balance: 2449, rateLimit: 5,
      unit: 'credits', renewable: false, code: null
    });
    expect(typeof report.checkedAt).toBe('string');
  });

  test('the value read is the one the vault serves, and it goes to read() with a timeout signal', async () => {
    const { probe, reads } = build();
    await probe.check('SERPER_API_KEY');
    expect(reads[0].key).toBe(SECRET);
    expect(reads[0].context.signal).toBeDefined();
  });

  test('no key, nothing probed: unknown, and never cached', async () => {
    const { probe, reads, values } = build({ value: null });
    expect(await probe.check('SERPER_API_KEY')).toMatchObject({ status: 'unknown', balance: null });
    expect(reads).toHaveLength(0);
    values.SERPER_API_KEY = SECRET;
    expect((await probe.check('SERPER_API_KEY')).status).toBe('ok');
    expect(reads).toHaveLength(1);
  });

  test('a failed reading says so with a code — never an invented number', async () => {
    const { probe } = build({ read: () => { throw new BalanceProbeError(BALANCE_ERRORS.TIMEOUT); } });
    expect(await probe.check('SERPER_API_KEY')).toMatchObject({ status: 'error', code: 'timeout', balance: null });
  });

  test('an answer without a usable balance is an error, not a zero', async () => {
    const { probe } = build({ read: () => ({ credits: 12 }) });
    expect(await probe.check('SERPER_API_KEY')).toMatchObject({ status: 'error', code: 'no_balance', balance: null });
  });

  test('an unexpected throw is reduced to a code; its message never reaches the log', async () => {
    const { probe, logged } = build({ read: () => { throw new Error(`request with ${SECRET} failed`); } });
    const report = await probe.check('SERPER_API_KEY');
    expect(report.code).toBe('failed');
    expect(logged.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  test('a reading is cached for cacheMs, then read again', async () => {
    const { probe, reads, advance } = build({ cacheMs: 60_000 });
    await probe.check('SERPER_API_KEY');
    advance(59_000);
    await probe.check('SERPER_API_KEY');
    expect(reads).toHaveLength(1);
    advance(2_000);
    await probe.check('SERPER_API_KEY');
    expect(reads).toHaveLength(2);
  });

  test('a failed reading is kept for less time than a good one', async () => {
    let fail = true;
    const { probe, reads, advance } = build({
      cacheMs: 300_000,
      errorCacheMs: 30_000,
      read: () => { if (fail) throw new BalanceProbeError('unreachable'); return { balance: 900 }; }
    });
    expect((await probe.check('SERPER_API_KEY')).status).toBe('error');
    advance(10_000);
    await probe.check('SERPER_API_KEY');
    expect(reads).toHaveLength(1);
    fail = false;
    advance(25_000);
    expect(await probe.check('SERPER_API_KEY')).toMatchObject({ status: 'ok', balance: 900 });
  });

  test('a changed key misses the cache: the old reading described another account', async () => {
    const { probe, reads, values } = build();
    await probe.check('SERPER_API_KEY');
    values.SERPER_API_KEY = 'a-brand-new-key-0000';
    await probe.check('SERPER_API_KEY');
    expect(reads.map((r) => r.key)).toEqual([SECRET, 'a-brand-new-key-0000']);
  });

  test('two screens asking at once share one request', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { probe, reads } = build({ read: async () => { await gate; return { balance: 10 }; } });
    const both = Promise.all([probe.check('SERPER_API_KEY'), probe.check('SERPER_API_KEY')]);
    release();
    const [a, b] = await both;
    expect(reads).toHaveLength(1);
    expect(a).toEqual(b);
    a.balance = 999;
    expect(b.balance).toBe(10);
  });

  test('a forced refresh reads again, but not closer than minRefreshMs to the last reading', async () => {
    const { probe, reads, advance } = build({ minRefreshMs: 10_000 });
    await probe.check('SERPER_API_KEY');
    advance(3_000);
    await probe.check('SERPER_API_KEY', { refresh: true });
    expect(reads).toHaveLength(1);
    advance(8_000);
    await probe.check('SERPER_API_KEY', { refresh: true });
    expect(reads).toHaveLength(2);
  });

  test('forget() drops the reading so the next check goes to the provider', async () => {
    const { probe, reads } = build();
    await probe.check('SERPER_API_KEY');
    probe.forget('SERPER_API_KEY');
    await probe.check('SERPER_API_KEY');
    expect(reads).toHaveLength(2);
  });

  test('a key without a probe is not a balance: null', async () => {
    const { probe } = build();
    expect(await probe.check('STRIPE_SECRET_KEY')).toBeNull();
    expect(probe.has('STRIPE_SECRET_KEY')).toBe(false);
  });

  test('checkAll reads every probed key and skips the others', async () => {
    const { probe } = build();
    const all = await probe.checkAll(['SERPER_API_KEY', 'OTHER']);
    expect(Object.keys(all)).toEqual(['SERPER_API_KEY']);
    expect(Object.keys(await probe.checkAll())).toEqual(['SERPER_API_KEY']);
  });

  test('a getValue that throws is an error report, not a crash', async () => {
    const probe = createBalanceProbe({
      getValue: async () => { throw new Error('store down'); },
      probes: { K: { read: async () => ({ balance: 1 }) } }
    });
    expect(await probe.check('K')).toMatchObject({ status: 'error', code: 'failed' });
  });

  test('wiring mistakes are refused up front', () => {
    const read = async () => ({ balance: 1 });
    expect(() => createBalanceProbe({ getValue: () => 'x' })).toThrow(/at least one probe/);
    expect(() => createBalanceProbe({ probes: { K: { read } } })).toThrow(/vault/);
    expect(() => createBalanceProbe({ getValue: () => 'x', probes: { K: {} } })).toThrow(/read/);
    expect(() => createBalanceProbe({ getValue: () => 'x', probes: { K: { read, thresholds: { low: 10, critical: 50 } } } })).toThrow(/critical/);
    expect(() => createBalanceProbe({ getValue: () => 'x', probes: { K: { read, thresholds: { low: -1 } } } })).toThrow(/non-negative/);
    const catalog = createCredentialCatalog({ spaces: [{ id: 's', keys: [{ key: 'A' }] }] });
    expect(() => createBalanceProbe({ getValue: () => 'x', catalog, probes: { B: { read } } })).toThrow(/catalog/);
  });

  test('over a real vault: the key typed in the interface wins over the environment', async () => {
    const catalog = createCredentialCatalog({ spaces: [{ id: 'web', keys: [{ key: 'SERPER_API_KEY' }] }] });
    const vault = createCredentialVault({
      store: createMemoryCredentialStore(),
      catalog,
      cipher: createFieldCipher({ key: generateFieldEncryptionKey() }),
      env: { SERPER_API_KEY: 'old-server-key' },
      cacheMs: 0
    });
    await vault.set('SERPER_API_KEY', SECRET);
    const seen = [];
    const probe = createBalanceProbe({ vault, catalog, probes: { SERPER_API_KEY: { read: async (key) => { seen.push(key); return { balance: 5 }; } } } });
    await probe.check('SERPER_API_KEY');
    expect(seen).toEqual([SECRET]);

    await vault.disconnect('SERPER_API_KEY');
    probe.forget();
    expect((await probe.check('SERPER_API_KEY')).status).toBe('unknown');
    expect(seen).toHaveLength(1);
  });
});

describe('Serper reader', () => {
  test('calls the account endpoint with the key in its header, and reads balance and rate', async () => {
    const { fetch, calls } = fakeFetch(json({ balance: 2449, rateLimit: 5 }));
    const read = createSerperBalanceReader({ fetch });
    await expect(read(SECRET)).resolves.toEqual({ balance: 2449, rateLimit: 5 });
    expect(calls[0].url).toBe(SERPER_ACCOUNT_URL);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers['X-API-KEY']).toBe(SECRET);
  });

  test('a missing rate limit is null, not zero', async () => {
    const read = createSerperBalanceReader({ fetch: fakeFetch(json({ balance: 12 })).fetch });
    await expect(read(SECRET)).resolves.toEqual({ balance: 12, rateLimit: null });
  });

  test.each([
    ['a refusal', json({ message: 'Unauthorized' }, 401), 'rejected'],
    ['an answer without balance', json({ credits: 3 }), 'no_balance'],
    ['a body that is not JSON', { status: 200, json: async () => { throw new SyntaxError('bad'); } }, 'unreadable'],
    ['a network failure', Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }), 'unreachable'],
    ['a timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'timeout']
  ])('%s becomes the code %s, and the key is nowhere in the error', async (_label, answer, code) => {
    const read = createSerperBalanceReader({ fetch: fakeFetch(answer).fetch });
    const error = await read(SECRET).catch((e) => e);
    expect(error).toBeInstanceOf(BalanceProbeError);
    expect(error.code).toBe(code);
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain(SECRET);
  });

  test('a refusal keeps its HTTP status, so a revoked key can be told from an outage', async () => {
    const read = createSerperBalanceReader({ fetch: fakeFetch(json({}, 403)).fetch });
    await expect(read(SECRET)).rejects.toMatchObject({ code: 'rejected', httpStatus: 403 });
  });

  test('serperBalanceProbe plugs straight into createBalanceProbe: 199 credits is critical', async () => {
    const probe = createBalanceProbe({
      getValue: () => SECRET,
      probes: { SERPER_API_KEY: serperBalanceProbe({ fetch: fakeFetch(json({ balance: 199, rateLimit: 5 })).fetch }) }
    });
    expect(await probe.check('SERPER_API_KEY')).toMatchObject({
      status: 'low', critical: true, balance: 199, unit: 'credits', renewable: false
    });
  });

  test('the reader refuses to be built without an injected fetch', () => {
    expect(() => createSerperBalanceReader({})).toThrow(/fetch/);
  });
});
