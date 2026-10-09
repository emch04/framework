const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const redisTest = process.env.REDIS_TEST_URL ? test : test.skip;

// The adapter owns its connection without exposing it. Isolate it in a process
// so that even a failed assertion cannot leave a connection alive in the runner.
redisTest('real Redis counters are shared across two rate-limit stores', async () => {
  const script = `
    const assert = require('node:assert/strict');
    const { randomUUID } = require('node:crypto');
    const { createClient } = require('redis');
    const { createRedisRateLimitStore } = require('./src');
    (async () => {
      const client = createClient({ url: process.env.REDIS_TEST_URL });
      client.on('error', () => {}); await client.connect();
      const prefix = 'integration:' + randomUUID() + ':';
      const a = createRedisRateLimitStore({ redisUrl: process.env.REDIS_TEST_URL, prefix });
      const b = createRedisRateLimitStore({ redisUrl: process.env.REDIS_TEST_URL, prefix });
      a.init({ windowMs: 1000 }); b.init({ windowMs: 1000 });
      try {
        // The public adapter starts in memory until its connection completes.
        for (const [index, store] of [a, b].entries()) {
          const deadline = Date.now() + 3000;
          let connected = false;
          while (Date.now() < deadline) {
            await store.increment('probe' + index);
            if ((await client.keys(prefix + '*probe' + index)).length) { connected = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(connected, true, 'Store must reach Redis');
        }
        const results = await Promise.all([a.increment('shared'), b.increment('shared')]);
        assert.deepEqual(results.map(r => r.totalHits).sort(), [1, 2]);
        assert.equal((await client.keys(prefix + '*shared*')).length, 1);
        await a.decrement('shared'); assert.equal((await b.increment('shared')).totalHits, 2);
        await b.resetKey('shared'); assert.equal((await a.increment('shared')).totalHits, 1);
        await new Promise(resolve => setTimeout(resolve, 1050));
        assert.equal((await b.increment('shared')).totalHits, 1);
      } finally {
        const keys = await client.keys(prefix + '*'); if (keys.length) await client.del(keys);
        a.shutdown(); b.shutdown(); await client.quit();
      }
    })().then(() => process.exit(0), () => { console.error('Redis integration assertion failed'); process.exit(1); });
  `;
  await promisify(execFile)(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '..'), timeout: 10000 });
}, 15000);
