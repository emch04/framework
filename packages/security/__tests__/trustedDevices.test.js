const {
  TrustedDeviceError,
  createTrustedDeviceService,
  createMemoryTrustedDeviceStore
} = require('../src');

const PEPPER = 'trusted-device-pepper-for-tests-0123456789';
const DAY = 24 * 60 * 60 * 1000;

function setup(overrides = {}) {
  let clock = 1_757_000_000_000;
  const store = createMemoryTrustedDeviceStore();
  const accounts = new Map([['alice', { credentialStamp: 'hash-v1' }], ['bob', { credentialStamp: 'bob-hash' }]]);
  const onReplay = jest.fn(async () => {});
  const service = createTrustedDeviceService({ store, pepper: PEPPER, onReplay, now: () => clock, ...overrides });
  const loadAccount = async (id) => accounts.get(id) || null;
  const enroll = (input = {}) => service.enroll({ accountId: 'alice', credentialStamp: 'hash-v1', deviceName: 'Phone', platform: 'ios', ...input });
  const exchange = (proof) => service.exchange(proof, { loadAccount });
  return { service, store, accounts, onReplay, enroll, exchange, advance: (ms) => { clock += ms; } };
}

const rejectedWith = (code = 'TRUSTED_DEVICE_REJECTED') => expect.objectContaining({ name: 'TrustedDeviceError', code });

describe('enrolment', () => {
  test('hands back an id and a secret, and keeps only a fingerprint of the secret', async () => {
    const { enroll, store, service } = setup();
    const { deviceId, secret } = await enroll();
    expect(deviceId).toMatch(/^[a-f0-9]{32}$/);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    const [row] = await store.all();
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.secretHash).toBe(service.fingerprint(secret));
    expect(JSON.stringify(row)).not.toContain('hash-v1');
  });

  test('refuses a session that has not proved the second factor the account requires', async () => {
    const { enroll, store } = setup();
    await expect(enroll({ requireSecondFactor: true, secondFactorVerified: false })).rejects.toEqual(rejectedWith('SECOND_FACTOR_REQUIRED'));
    expect(await store.all()).toHaveLength(0);
  });

  test('bounded: the sixth device pushes out the least recently used', async () => {
    const { enroll, service, advance } = setup();
    const first = await enroll();
    for (let i = 0; i < 5; i += 1) { advance(1000); await enroll(); }
    const listed = await service.list('alice');
    expect(listed).toHaveLength(5);
    expect(listed.map((d) => d.id)).not.toContain(first.id);
  });

  test('names are cleaned before they are ever shown back', async () => {
    const { enroll, service } = setup();
    await enroll({ deviceName: '<b>Phone</b>\u0000', platform: 'windows-phone' });
    const [device] = await service.list('alice');
    expect(device).toMatchObject({ deviceName: 'bPhone/b', platform: 'other' });
  });
});

describe('exchange', () => {
  test('trades the secret for a new one, three times in a row', async () => {
    const { enroll, exchange } = setup();
    let { deviceId, secret } = await enroll();
    for (let i = 0; i < 3; i += 1) {
      const result = await exchange({ deviceId, secret });
      expect(result.accountId).toBe('alice');
      expect(result.secret).not.toBe(secret);
      secret = result.secret;
    }
  });

  test('REPLAY: a spent secret kills the device and asks for every session to go', async () => {
    const { enroll, exchange, onReplay, store } = setup();
    const { deviceId, secret: first } = await enroll();
    const second = (await exchange({ deviceId, secret: first })).secret;

    await expect(exchange({ deviceId, secret: first })).rejects.toEqual(rejectedWith());
    expect(onReplay).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'alice' }));
    expect((await store.all())[0].revokedReason).toBe('replay');
    /* The holder of the current secret — perhaps the thief — is out too. */
    await expect(exchange({ deviceId, secret: second })).rejects.toEqual(rejectedWith());
  });

  test('REPLAY: two simultaneous uses of one secret — exactly one wins', async () => {
    const { enroll, exchange, onReplay } = setup();
    const { deviceId, secret } = await enroll();
    const results = await Promise.allSettled([exchange({ deviceId, secret }), exchange({ deviceId, secret })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  test('a wrong secret is refused but touches nothing', async () => {
    const { enroll, exchange, onReplay } = setup();
    const { deviceId, secret } = await enroll();
    await expect(exchange({ deviceId, secret: 'f'.repeat(64) })).rejects.toEqual(rejectedWith());
    expect(onReplay).not.toHaveBeenCalled();
    await expect(exchange({ deviceId, secret })).resolves.toMatchObject({ accountId: 'alice' });
  });

  test('EXPIRATION: idle for the whole lifetime, the device is gone', async () => {
    const { enroll, exchange, advance } = setup();
    const { deviceId, secret } = await enroll();
    advance(30 * DAY);
    await expect(exchange({ deviceId, secret })).rejects.toEqual(rejectedWith());
  });

  test('EXPIRATION: each use pushes the deadline forward', async () => {
    const { enroll, exchange, advance } = setup();
    let { deviceId, secret } = await enroll();
    advance(29 * DAY);
    secret = (await exchange({ deviceId, secret })).secret;
    advance(29 * DAY);
    await expect(exchange({ deviceId, secret })).resolves.toMatchObject({ accountId: 'alice' });
  });

  test('CREDENTIAL: a password changed by any path switches the device off', async () => {
    const { enroll, exchange, accounts, store } = setup();
    const { deviceId, secret } = await enroll();
    accounts.set('alice', { credentialStamp: 'hash-v2' });
    await expect(exchange({ deviceId, secret })).rejects.toEqual(rejectedWith());
    expect((await store.all())[0].revokedReason).toBe('account-changed');
  });

  test('a disabled or vanished account gets nothing, and the device is switched off', async () => {
    const { enroll, exchange, accounts } = setup();
    const one = await enroll();
    accounts.set('alice', { credentialStamp: 'hash-v1', disabled: true });
    await expect(exchange(one)).rejects.toEqual(rejectedWith());
    accounts.delete('alice');
    const two = await enroll();
    await expect(exchange(two)).rejects.toEqual(rejectedWith());
  });

  test('the second factor proven at enrolment travels with the exchange', async () => {
    const { enroll, exchange } = setup();
    const withFactor = await enroll({ requireSecondFactor: true, secondFactorVerified: true });
    const without = await enroll();
    expect((await exchange(withFactor)).secondFactorVerified).toBe(true);
    expect((await exchange(without)).secondFactorVerified).toBe(false);
  });

  test('ATTEMPT LIMIT: past ten tries per device, throttled — even with the right secret', async () => {
    const { enroll, exchange } = setup();
    const { deviceId, secret } = await enroll();
    for (let i = 0; i < 10; i += 1) {
      await expect(exchange({ deviceId, secret: 'a'.repeat(64) })).rejects.toEqual(rejectedWith());
    }
    const error = await exchange({ deviceId, secret }).catch((e) => e);
    expect(error).toBeInstanceOf(TrustedDeviceError);
    expect(error.code).toBe('TRUSTED_DEVICE_THROTTLED');
    expect(error.statusCode).toBe(429);
    expect(error.retryAfterMs).toBeGreaterThan(0);
  });

  test('ATTEMPT LIMIT: the window resets', async () => {
    const { enroll, exchange, advance } = setup();
    const { deviceId, secret } = await enroll();
    for (let i = 0; i < 11; i += 1) await exchange({ deviceId, secret: 'a'.repeat(64) }).catch(() => {});
    advance(15 * 60 * 1000);
    await expect(exchange({ deviceId, secret })).resolves.toMatchObject({ accountId: 'alice' });
  });

  test('every failure is the SAME error — nothing to learn by probing', async () => {
    const { enroll, exchange } = setup();
    const { deviceId } = await enroll();
    const errors = await Promise.all([
      exchange({ deviceId: 'nope', secret: 'x' }),
      exchange({ deviceId: 'b'.repeat(32), secret: 'c'.repeat(64) }),
      exchange({ deviceId, secret: 'd'.repeat(64) }),
      exchange(null)
    ].map((p) => p.catch((e) => e)));
    for (const error of errors) {
      expect(error).toEqual(rejectedWith());
      expect(error.message).toBe('TRUSTED_DEVICE_REJECTED');
    }
  });
});

describe('revocation', () => {
  test('REVOCATION: revokeAll kills every device of the account', async () => {
    const { enroll, exchange, service, onReplay } = setup();
    const one = await enroll();
    const two = await enroll();
    await service.revokeAll('alice', 'sessions-revoked');
    await expect(exchange(one)).rejects.toEqual(rejectedWith());
    await expect(exchange(two)).rejects.toEqual(rejectedWith());
    expect(await service.list('alice')).toEqual([]);
    /* A revoked device is simply refused. Treating it as a replay would sign
       the owner out everywhere and raise an alarm for their own old phone. */
    expect(onReplay).not.toHaveBeenCalled();
  });

  test('REVOCATION: the owner removes one device, which no longer signs in', async () => {
    const { enroll, exchange, service } = setup();
    const one = await enroll();
    const two = await enroll();
    expect(await service.remove('alice', one.id)).toBe(true);
    await expect(exchange(one)).rejects.toEqual(rejectedWith());
    await expect(exchange(two)).resolves.toMatchObject({ accountId: 'alice' });
  });

  test('ANOTHER ACCOUNT can neither see nor remove my devices', async () => {
    const { enroll, exchange, service } = setup();
    const mine = await enroll();
    expect(await service.list('bob')).toEqual([]);
    expect(await service.remove('bob', mine.id)).toBe(false);
    await expect(exchange(mine)).resolves.toMatchObject({ accountId: 'alice' });
  });

  test('forget needs the current secret; a wrong one changes nothing', async () => {
    const { enroll, exchange, service } = setup();
    const device = await enroll();
    await service.forget({ deviceId: device.deviceId, secret: 'e'.repeat(64) });
    await expect(exchange(device)).resolves.toBeTruthy();
    const other = await enroll();
    await service.forget(other);
    await expect(exchange(other)).rejects.toEqual(rejectedWith());
  });

  test('the list never shows the secret, its fingerprint, or the lookup key', async () => {
    const { enroll, service } = setup();
    const { deviceId, secret } = await enroll();
    const listed = JSON.stringify(await service.list('alice'));
    expect(listed).not.toContain(secret);
    expect(listed).not.toContain(deviceId);
    expect(listed).not.toContain(service.fingerprint(secret));
  });

  test('a failing onReplay does not bring the device back', async () => {
    const onError = jest.fn();
    const { enroll, exchange, store } = setup({ onReplay: async () => { throw new Error('session store down'); }, onError });
    const { deviceId, secret } = await enroll();
    await exchange({ deviceId, secret });
    await expect(exchange({ deviceId, secret })).rejects.toEqual(rejectedWith());
    expect(onError).toHaveBeenCalledTimes(1);
    expect((await store.all())[0].revokedAt).not.toBeNull();
  });
});
