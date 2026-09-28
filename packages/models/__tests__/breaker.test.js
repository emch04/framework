const { createEndpointBreaker, ModelsCircuitOpenError } = require('../src');

function setup(options = {}) {
  let t = 1000;
  const changes = [];
  const breaker = createEndpointBreaker({ now: () => t, onStateChange: (c) => changes.push(`${c.from}>${c.to}`), ...options });
  return { breaker, changes, advance: (ms) => { t += ms; } };
}

const fail = () => Promise.reject(new Error('down'));

test('opens after the threshold and refuses with CIRCUIT_OPEN and the remaining delay', async () => {
  const { breaker, changes, advance } = setup();
  for (let i = 0; i < 3; i += 1) await expect(breaker.call(fail)).rejects.toThrow('down');
  advance(10_000);
  const refusal = await breaker.call(() => 'x').catch((e) => e);
  expect(refusal).toBeInstanceOf(ModelsCircuitOpenError);
  expect(refusal).toMatchObject({ code: 'CIRCUIT_OPEN', retryInMs: 50_000 });
  expect(changes).toEqual(['closed>open']);
  expect(breaker.status()).toEqual({ name: 'models', state: 'open', failures: 3, openedAt: 1000 });
});

test('half-open lets a single probe through while it runs', async () => {
  const { breaker, advance } = setup({ failureThreshold: 1, recoveryMs: 100 });
  await breaker.call(fail).catch(() => {});
  advance(100);
  expect(breaker.isOpen()).toBe(false);
  let release;
  const probe = breaker.call(() => new Promise((resolve) => { release = resolve; }));
  expect(breaker.isOpen()).toBe(true);
  await expect(breaker.call(() => 'second')).rejects.toMatchObject({ code: 'CIRCUIT_OPEN' });
  release('done');
  await expect(probe).resolves.toBe('done');
  expect(breaker.status().state).toBe('closed');
});

test('reset closes it; an observer that throws is ignored', async () => {
  const breaker = createEndpointBreaker({ failureThreshold: 1, onStateChange: () => { throw new Error('observer'); } });
  await breaker.call(fail).catch(() => {});
  expect(breaker.isOpen()).toBe(true);
  breaker.reset();
  expect(breaker.isOpen()).toBe(false);
  await expect(breaker.call(() => 7)).resolves.toBe(7);
});
