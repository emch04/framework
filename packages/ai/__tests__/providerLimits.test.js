const { readRetryAfter, createInferenceQueue } = require('../src');
const header = (value) => ({ headers: { get: () => value } });
test('Retry-After accepts seconds and HTTP dates, refuses malformed/negative values', () => {
  const time = Date.parse('2026-10-08T12:00:00Z');
  expect(readRetryAfter(header('2.5'), time)).toBe(2500);
  expect(readRetryAfter(header('Thu, 08 Oct 2026 12:00:02 GMT'), time)).toBe(2000);
  expect(readRetryAfter(header('Thu, 08 Oct 2026 11:00:00 GMT'), time)).toBe(0);
  expect(readRetryAfter(header('-1'), time)).toBeNull();
  expect(readRetryAfter(header('invalid'), time)).toBeNull();
  expect(readRetryAfter({})).toBeNull();
});

test('bounded inference queue caps parallel work and waiting calls, preserving FIFO', async () => {
  const queue = createInferenceQueue({ maxConcurrent: 1, maxQueue: 1 });
  let release;
  const first = queue.run(() => new Promise((done) => { release = done; }));
  await Promise.resolve();
  const second = queue.run(async () => 'second');
  await expect(queue.run(async () => 'third')).rejects.toMatchObject({ code: 'AI_LOCAL_QUEUE_FULL' });
  expect(queue.stats()).toEqual({ active: 1, waiting: 1 });
  release('first'); expect(await first).toBe('first'); expect(await second).toBe('second');
  expect(queue.stats()).toEqual({ active: 0, waiting: 0 });
});

test('queue releases failed work, removes aborted waiters and never runs them', async () => {
  const queue = createInferenceQueue({ maxConcurrent: 1, maxQueue: 1 });
  let release; const first = queue.run(() => new Promise((done) => { release = done; })); await Promise.resolve();
  const controller = new globalThis.AbortController(); const work = jest.fn();
  const wait = queue.run(work, { signal: controller.signal }); controller.abort(new Error('left'));
  await expect(wait).rejects.toThrow('left'); expect(queue.stats().waiting).toBe(0); expect(work).not.toHaveBeenCalled();
  release(); await first;
  await expect(queue.run(async () => { throw new Error('failed'); })).rejects.toThrow('failed');
  expect(await queue.run(async () => 'recovered')).toBe('recovered');
  expect(() => createInferenceQueue({ maxConcurrent: 0 })).toThrow('INVALID_INFERENCE_QUEUE');
});
