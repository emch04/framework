import {
  CircuitOpenError,
  createCache,
  createCircuitBreaker,
  createJobLock,
  createMemoryCacheStore,
  createMemoryLockStore,
  createMongoLockStore,
  createRedisLockStore,
  createTimerRegistry,
  defaultShouldRetry,
  retry
} from './src';
import type { Cache, CacheStore, CircuitBreaker, CircuitState, JobLock, LockStore, TimerRegistry } from './src';

const breaker: CircuitBreaker = createCircuitBreaker({
  name: 'ia',
  failureThreshold: 3,
  recoveryMs: 20_000,
  isFailure: (error) => !(error instanceof CircuitOpenError),
  onStateChange: ({ from, to }) => void [from, to] as unknown as void,
  now: () => Date.now()
});

const state: CircuitState = breaker.status().state;
const guarded = breaker.wrap(async (a: number, b: number) => a + b);

const store: CacheStore = createMemoryCacheStore({ maxEntries: 100 });
const cache: Cache = createCache({ store, ttlSeconds: 300, prefix: 'svc', logger: { warn: () => {} } });

async function exercise(): Promise<void> {
  const viaBreaker: string = await breaker.call(async () => 'ok');
  const sum: number = await guarded(2, 3);
  breaker.reset();

  await cache.set('user', { id: 1 });
  const user: { id: number } | null = await cache.get('user');
  const stats: { total: number } = await cache.remember('stats', async () => ({ total: 42 }), 60);
  await cache.invalidate('user');

  const fetched: string = await retry(async (attempt) => `try ${attempt}`, {
    attempts: 3,
    baseDelayMs: 100,
    shouldRetry: defaultShouldRetry,
    onRetry: (error, attempt, delayMs) => void [error, attempt, delayMs]
  });

  const lockStore: LockStore = createMemoryLockStore();
  const lock: JobLock = createJobLock({ store: lockStore, owner: 'worker-1', prefix: 'jobs:' });
  const claimed: boolean = await lock.claim('reminders', 55 * 60_000);
  const sent: number | null = await lock.run('reminders', 55 * 60_000, async () => 3);
  const released: boolean = await lock.release('reminders');
  const mongoStore: LockStore = createMongoLockStore({
    updateOne: async () => ({}),
    deleteOne: async () => ({ deletedCount: 1 })
  });
  const redisStore: LockStore = createRedisLockStore({ command: async (args: string[]) => args.length });

  const registry: TimerRegistry = createTimerRegistry();
  const tracked: ReturnType<typeof setInterval> = registry.track(setInterval(() => {}, 1000), { key: 'cleanup' });
  registry.every(60_000, () => {}, { key: 'sweep' });
  registry.after(5_000, () => {});
  const cancelled: boolean = registry.cancel(tracked);
  registry.stopAll();
  const stopped: boolean = registry.isStopped();

  void [viaBreaker, sum, user, stats, fetched, state, breaker.isOpen()];
  void [claimed, sent, released, mongoStore, redisStore, lock.owner, cancelled, stopped, registry.size()];
}

void exercise;
