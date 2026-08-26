const { createMemoryKeystore, createBiometricGate } = require('../src');

function gate(overrides = {}) {
  const keystore = overrides.keystore || createMemoryKeystore();
  const authenticator = {
    hasHardwareAsync: async () => true,
    isEnrolledAsync: async () => true,
    authenticateAsync: async () => ({ success: true }),
    ...overrides.authenticator
  };
  return { keystore, authenticator, gate: createBiometricGate({ keystore, authenticator, namespace: 'acme' }) };
}

describe('createBiometricGate', () => {
  test('reports supported only when the device has hardware AND an enrolled finger', async () => {
    const noHardware = gate({ authenticator: { hasHardwareAsync: async () => false } });
    const noFinger = gate({ authenticator: { isEnrolledAsync: async () => false } });

    expect((await noHardware.gate.read()).supported).toBe(false);
    expect((await noFinger.gate.read()).supported).toBe(false);
    expect((await gate().gate.read()).supported).toBe(true);
  });

  test('starts disabled, and enable stores the flag only after a successful prompt', async () => {
    const { gate: g, keystore } = gate();

    expect((await g.read()).enabled).toBe(false);
    const result = await g.enable({ promptMessage: 'Acme' });

    expect(result.enabled).toBe(true);
    expect(await keystore.getItemAsync('acme.biometric.enabled')).toBe('true');
  });

  test('a refused prompt leaves the gate closed', async () => {
    const { gate: g, keystore } = gate({ authenticator: { authenticateAsync: async () => ({ success: false }) } });

    const result = await g.enable();

    expect(result.enabled).toBe(false);
    expect(result.failed).toBe(false);
    expect(await keystore.getItemAsync('acme.biometric.enabled')).toBeNull();
  });

  test('an authenticator that throws reports a failure instead of propagating', async () => {
    const { gate: g } = gate({ authenticator: { authenticateAsync: async () => { throw new Error('sensor busy'); } } });

    const result = await g.enable();

    expect(result.enabled).toBe(false);
    expect(result.failed).toBe(true);
  });

  test('enabling on a device that cannot do it is refused without prompting', async () => {
    let prompted = false;
    const { gate: g } = gate({
      authenticator: {
        hasHardwareAsync: async () => false,
        authenticateAsync: async () => { prompted = true; return { success: true }; }
      }
    });

    const result = await g.enable();

    expect(result.enabled).toBe(false);
    expect(result.supported).toBe(false);
    expect(prompted).toBe(false);
  });

  test('disable removes the flag', async () => {
    const { gate: g, keystore } = gate();
    await g.enable();

    await g.disable();

    expect(await keystore.getItemAsync('acme.biometric.enabled')).toBeNull();
    expect((await g.read()).enabled).toBe(false);
  });

  test('confirm prompts and answers whether the person is there', async () => {
    const { gate: g } = gate();
    await g.enable();

    await expect(g.confirm({ promptMessage: 'Acme' })).resolves.toBe(true);
  });

  test('confirm refuses when the gate was never enabled', async () => {
    let prompted = false;
    const { gate: g } = gate({
      authenticator: { authenticateAsync: async () => { prompted = true; return { success: true }; } }
    });

    await expect(g.confirm()).resolves.toBe(false);
    expect(prompted).toBe(false);
  });
  test('a flag left over from a device whose finger was removed does not count as enabled', async () => {
    const keystore = createMemoryKeystore();
    await keystore.setItemAsync('acme.biometric.enabled', 'true');
    const { gate: g } = gate({ keystore, authenticator: { isEnrolledAsync: async () => false } });

    const state = await g.read();

    expect(state.enabled).toBe(false);
    expect(state.supported).toBe(false);
  });

  test('confirm refuses when the device lost its enrollment', async () => {
    const keystore = createMemoryKeystore();
    await keystore.setItemAsync('acme.biometric.enabled', 'true');
    let prompted = false;
    const { gate: g } = gate({
      keystore,
      authenticator: {
        isEnrolledAsync: async () => false,
        authenticateAsync: async () => { prompted = true; return { success: true }; }
      }
    });

    await expect(g.confirm()).resolves.toBe(false);
    expect(prompted).toBe(false);
  });
});
