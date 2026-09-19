const crypto = require('crypto');
const {
  ipFamily,
  createMemoryLoginDeviceStore,
  createLoginDeviceTracker,
  createChangeAlerts,
  createSecurityAlerter,
  DEFAULT_MAX_LOGIN_DEVICES
} = require('../src');

const SECRET = 'device-fingerprint-secret-for-tests';

function tracker(overrides = {}) {
  let clock = 1_757_000_000_000;
  const store = overrides.store || createMemoryLoginDeviceStore();
  const notify = jest.fn(async () => {});
  const onError = jest.fn();
  const t = createLoginDeviceTracker({ store, secret: SECRET, notify, onError, now: () => (clock += 1000), ...overrides.options });
  return { t, store, notify, onError };
}

const ALICE = { id: 'alice', locale: 'fr' };

describe('address families', () => {
  test('/16 in IPv4, mapped IPv4 included', () => {
    expect(ipFamily('203.0.113.7')).toBe('203.0.0.0/16');
    expect(ipFamily('::ffff:203.0.113.7')).toBe('203.0.0.0/16');
  });

  test('/48 in IPv6, whatever the notation', () => {
    expect(ipFamily('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    /* Splitting the literal on ':' made these two different families. */
    expect(ipFamily('2001:db8::5')).toBe(ipFamily('2001:0db8:0000:0001::5'));
    expect(ipFamily('2001:db8::5')).toBe('2001:db8:0::/48');
  });

  test('anything else is "unknown"', () => {
    expect(ipFamily(undefined)).toBe('unknown');
    expect(ipFamily('999.1.1.1')).toBe('unknown');
    expect(ipFamily('1:2:3:4:5:6:7:8:9')).toBe('unknown');
  });
});

describe('new sign-in device', () => {
  test('the very first sign-in is remembered without an alert', async () => {
    const { t, notify } = tracker();
    expect(await t.record(ALICE, { ip: '203.0.113.7', userAgent: 'UA' })).toEqual({ isNew: true, firstDevice: true, notified: false });
    expect(notify).not.toHaveBeenCalled();
  });

  test('the same device on another antenna of the same carrier: no alert', async () => {
    const { t, notify, store } = tracker();
    await t.record(ALICE, { ip: '203.0.113.7', userAgent: 'UA' });
    await t.record(ALICE, { ip: '203.0.58.99', userAgent: 'UA' });
    expect(await store.all()).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });

  test('a new device after the first warns the account holder, with no words attached', async () => {
    const { t, notify } = tracker();
    await t.record(ALICE, { ip: '203.0.113.7', userAgent: 'UA' });
    const result = await t.record(ALICE, { ip: '198.51.100.8', userAgent: 'App/1.0' });
    expect(result).toEqual({ isNew: true, firstDevice: false, notified: true });
    expect(notify).toHaveBeenCalledWith(ALICE, { type: 'new-login-device', at: expect.any(Number) });
  });

  test('accounts do not share devices', async () => {
    const { t, notify } = tracker();
    await t.record(ALICE, { ip: '203.0.113.7', userAgent: 'UA' });
    await t.record({ id: 'bob' }, { ip: '203.0.113.7', userAgent: 'UA' });
    expect(notify).not.toHaveBeenCalled();
  });

  test('bounded per account: the least recently seen leaves', async () => {
    const { t, store } = tracker();
    for (let i = 0; i <= DEFAULT_MAX_LOGIN_DEVICES; i += 1) {
      await t.record(ALICE, { ip: `10.${i}.0.1`, userAgent: `Agent ${i}` });
    }
    const rows = await store.all();
    expect(rows).toHaveLength(DEFAULT_MAX_LOGIN_DEVICES);
    expect(rows.map((row) => row.fingerprint)).not.toContain(t.fingerprint({ ip: '10.0.0.1', userAgent: 'Agent 0' }));
  });

  test('nothing is kept in the clear', async () => {
    const { t, store } = tracker();
    await t.record(ALICE, { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 Test' });
    const [row] = await store.all();
    expect(row.fingerprint).toBe(crypto.createHmac('sha256', SECRET).update('203.0.0.0/16|Mozilla/5.0 Test').digest('hex'));
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');
  });

  test('a store failure never reaches the sign-in', async () => {
    const store = { upsert: async () => { throw new Error('db down'); }, count: async () => 0 };
    const { t, onError, notify } = tracker({ store });
    await expect(t.record(ALICE, { ip: '203.0.113.7' })).resolves.toMatchObject({ error: true });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('change alerts', () => {
  function alerts() {
    const sent = [];
    let failing = false;
    const onError = jest.fn();
    const a = createChangeAlerts({
      send: async (message) => { if (failing) throw new Error('smtp down'); sent.push(message); },
      onError
    });
    return { a, sent, onError, fail: () => { failing = true; } };
  }

  test('a password change warns the account address, as a catalogue key in the account locale', async () => {
    const { a, sent } = alerts();
    expect(await a.alert(ALICE, 'password', { to: 'alice@example.test' })).toBe(true);
    expect(sent[0]).toMatchObject({ to: 'alice@example.test', key: 'security.change.password', locale: 'fr' });
  });

  test('an e-mail change warns the PREVIOUS address, and names the new one', async () => {
    const { a, sent } = alerts();
    await a.alert(ALICE, 'email', { to: 'new@elsewhere.test', previousEmail: 'old@example.test', newEmail: 'new@elsewhere.test' });
    expect(sent[0].to).toBe('old@example.test');
    expect(sent[0].detail).toBe('new@elsewhere.test');
  });

  test('a FIRST address warns nobody', async () => {
    const { a, sent } = alerts();
    expect(await a.alert(ALICE, 'email', { newEmail: 'first@example.test' })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('factor changes are alerts too', async () => {
    const { a, sent } = alerts();
    for (const change of ['factor-added', 'factor-removed', 'recovery-codes', 'trusted-device']) {
      await a.alert(ALICE, change, { to: 'alice@example.test', detail: 'Phone (iOS)' });
    }
    expect(sent.map((m) => m.key)).toEqual([
      'security.change.factor-added', 'security.change.factor-removed',
      'security.change.recovery-codes', 'security.change.trusted-device'
    ]);
  });

  test('no recipient: nothing sent, nothing thrown', async () => {
    const { a, sent } = alerts();
    expect(await a.alert(ALICE, 'password', {})).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('A FAILED SEND NEVER FAILS THE CHANGE', async () => {
    const { a, fail, onError } = alerts();
    fail();
    await expect(a.alert(ALICE, 'password', { to: 'alice@example.test' })).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('an unknown change type is a programming error', async () => {
    const { a } = alerts();
    await expect(a.alert(ALICE, 'typo', { to: 'x@y.test' })).rejects.toThrow(/Unknown change/);
  });
});

describe('operator alerts', () => {
  test('one channel down does not silence the others', async () => {
    const good = jest.fn(async () => true);
    const alerter = createSecurityAlerter({ channels: [async () => { throw new Error('webhook down'); }, good] });
    expect(await alerter.send({ level: 'FATAL', type: 'replay' })).toBe(true);
    expect(good).toHaveBeenCalledWith(expect.objectContaining({ level: 'FATAL', type: 'replay' }));
  });

  test('no channel: false, and an unknown level falls back to WARN', async () => {
    expect(await createSecurityAlerter().send({})).toBe(false);
    const seen = [];
    await createSecurityAlerter({ channels: [async (a) => seen.push(a)] }).send({ level: 'PANIC' });
    expect(seen[0].level).toBe('WARN');
  });
});
