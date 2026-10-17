/**
 * The EventLog contract, shared by every store (memory, PostgreSQL…): a store
 * that passes it can protect a webhook against replays, concurrent ones
 * included. `make({ claimTtlMs, now })` returns a fresh, empty log.
 */
function runEventLogContract(label, make, options = {}) {
  const maybe = options.skip ? describe.skip : describe;

  maybe(`${label}: event log contract`, () => {
    test('remembers what it has recorded, without confusing two events', async () => {
      const log = await make();
      expect(await log.seen('evt_1')).toBe(false);
      await log.record('evt_1');
      expect(await log.seen('evt_1')).toBe(true);
      expect(await log.seen('evt_2')).toBe(false);
    });

    test('a numeric id and its string form are the same event', async () => {
      const log = await make();
      await log.record(42);
      expect(await log.seen('42')).toBe(true);
    });

    test('claim reserves an event once, atomically', async () => {
      const log = await make();
      const results = await Promise.all([log.claim('evt_1'), log.claim('evt_1'), log.claim('evt_1')]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await log.claim('evt_1')).toBe(false);
      expect(await log.seen('evt_1')).toBe(false);
    });

    test('release frees a claim so the event can be handled again', async () => {
      const log = await make();
      await log.claim('evt_1');
      await log.release('evt_1');
      expect(await log.claim('evt_1')).toBe(true);
    });

    test('release never undoes an event already recorded as handled', async () => {
      const log = await make();
      await log.claim('evt_1');
      await log.record('evt_1');
      await log.release('evt_1');
      expect(await log.seen('evt_1')).toBe(true);
      expect(await log.claim('evt_1')).toBe(false);
    });

    test('a claim abandoned by a crashed process expires; a handled event never does', async () => {
      let now = Date.parse('2026-10-17T10:00:00Z');
      const log = await make({ claimTtlMs: 1000, now: () => now });
      await log.claim('stuck');
      await log.claim('done');
      await log.record('done');
      now += 999;
      expect(await log.claim('stuck')).toBe(false);
      now += 1500;
      expect(await log.claim('stuck')).toBe(true);
      expect(await log.claim('done')).toBe(false);
    });
  });
}

module.exports = { runEventLogContract };
