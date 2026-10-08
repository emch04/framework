const { createKeyProbe } = require('../src');
const value = ['private', 'fixture'].join('-');
test.each(['ok', 'rejected', 'quota', 'unavailable'])('probe returns only status %s and uses injected transport', async status => {
  const transport = jest.fn(async () => status);
  const probe = jest.fn(async (key, { transport, signal }) => { expect(key).toBe(value); expect(signal.aborted).toBe(false); return transport('fixed-endpoint'); });
  const checks = createKeyProbe({ vault: { get: async () => value }, probes: { KEY: probe }, transport });
  expect(await checks.check('KEY')).toEqual({ status });
  expect(transport).toHaveBeenCalledWith('fixed-endpoint');
});
test.each([value, { status: 'ok', value }, 'unsupported', null])('untrusted provider output never leaves probe', async result => {
  const checks = createKeyProbe({ vault: { get: async () => value }, probes: { KEY: async () => result }, transport: jest.fn() });
  expect(await checks.check('KEY')).toEqual({ status: 'unavailable' });
});
test('provider and vault errors are sanitized', async () => {
  const checks = createKeyProbe({ vault: { get: async () => value }, probes: { KEY: async () => { throw new Error(value); } }, transport: jest.fn() });
  expect(await checks.check('KEY')).toEqual({ status: 'unavailable' });
  const unreadable = createKeyProbe({ vault: { get: async () => { throw new Error(value); } }, probes: { KEY: jest.fn() }, transport: jest.fn() });
  expect(await unreadable.check('KEY')).toEqual({ status: 'unavailable' });
});
test('missing/disconnected values and unknown services do not call transport', async () => {
  const probe = jest.fn();
  const checks = createKeyProbe({ vault: { get: async () => null }, probes: { KEY: probe }, transport: jest.fn() });
  expect(await checks.check('KEY')).toEqual({ status: 'unavailable' });
  expect(await checks.check('toString')).toEqual({ status: 'unavailable' });
  expect(probe).not.toHaveBeenCalled();
});
test('timeout aborts a pending provider even when it ignores cancellation', async () => {
  let signal;
  const checks = createKeyProbe({ vault: { get: async () => value }, probes: { KEY: async (_key, ctx) => { signal = ctx.signal; return new Promise(() => {}); } }, transport: jest.fn(), timeoutMs: 5 });
  expect(await checks.check('KEY')).toEqual({ status: 'unavailable' });
  expect(signal.aborted).toBe(true);
});
test('required injection and timeout configuration are validated', () => {
  expect(() => createKeyProbe({})).toThrow('injected transport');
  expect(() => createKeyProbe({ vault: { get() {} }, probes: {}, transport() {}, timeoutMs: 0 })).toThrow('timeoutMs');
});
