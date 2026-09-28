/**
 * The consent store contract, as a test suite. An adapter for a real database
 * proves it behaves like the reference store:
 *
 *   const { runConsentStoreContract } = require('@astratra/privacy');
 *   runConsentStoreContract(async () => createMongoConsentStore(await freshCollection()));
 *
 * It uses the test runner's describe/test/expect (jest or a compatible one);
 * pass them explicitly when they are not globals.
 */

function consentRecord(overrides = {}) {
  return {
    subject: 'subject-a',
    scope: 'ai',
    granted: true,
    version: 2,
    decidedAt: '2026-09-28T10:00:00.000Z',
    ...overrides
  };
}

function runConsentStoreContract(makeStore, runner = {}) {
  const describe = runner.describe || globalThis.describe;
  const test = runner.test || globalThis.test;
  const expect = runner.expect || globalThis.expect;
  if (typeof describe !== 'function' || typeof test !== 'function' || typeof expect !== 'function') {
    throw new Error('runConsentStoreContract needs describe, test and expect (pass them, or run it inside jest).');
  }

  const time = (value) => new Date(value).getTime();

  describe('consent store contract', () => {
    test('nothing stored reads as null — never decided is not refused', async () => {
      const store = await makeStore();
      expect(await store.get('subject-a', 'ai')).toBeNull();
      expect(await store.list('subject-a')).toEqual([]);
    });

    test('put then get returns the decision, and the returned object is a copy', async () => {
      const store = await makeStore();
      await store.put(consentRecord());
      const got = await store.get('subject-a', 'ai');
      expect(got).toMatchObject({ subject: 'subject-a', scope: 'ai', granted: true, version: 2 });
      expect(time(got.decidedAt)).toBe(time('2026-09-28T10:00:00.000Z'));
      got.granted = false;
      expect((await store.get('subject-a', 'ai')).granted).toBe(true);
    });

    test('a new decision REPLACES the previous one for the same subject and scope', async () => {
      const store = await makeStore();
      await store.put(consentRecord());
      await store.put(consentRecord({ granted: false, decidedAt: '2026-09-29T10:00:00.000Z' }));
      expect((await store.get('subject-a', 'ai')).granted).toBe(false);
      expect(await store.list('subject-a')).toHaveLength(1);
    });

    test('a refusal is stored like a yes — a withdrawal must reach the other devices', async () => {
      const store = await makeStore();
      await store.put(consentRecord({ granted: false }));
      expect((await store.get('subject-a', 'ai')).granted).toBe(false);
    });

    test('scopes are separate: a yes to one is not a yes to another', async () => {
      const store = await makeStore();
      await store.put(consentRecord({ scope: 'ai' }));
      expect(await store.get('subject-a', 'web')).toBeNull();
      await store.put(consentRecord({ scope: 'web', granted: false }));
      expect((await store.get('subject-a', 'ai')).granted).toBe(true);
    });

    test('one subject never reads another subject\'s decision', async () => {
      const store = await makeStore();
      await store.put(consentRecord({ subject: 'subject-a' }));
      expect(await store.get('subject-b', 'ai')).toBeNull();
      expect(await store.list('subject-b')).toEqual([]);
      expect(await store.remove('subject-b')).toBe(0);
      expect(await store.get('subject-a', 'ai')).not.toBeNull();
    });

    test('list returns every scope of one subject', async () => {
      const store = await makeStore();
      await store.put(consentRecord({ scope: 'ai' }));
      await store.put(consentRecord({ scope: 'web' }));
      await store.put(consentRecord({ subject: 'subject-b', scope: 'ai' }));
      const scopes = (await store.list('subject-a')).map((row) => row.scope).sort();
      expect(scopes).toEqual(['ai', 'web']);
    });

    test('remove one scope, or all of a subject, and say how many went', async () => {
      const store = await makeStore();
      await store.put(consentRecord({ scope: 'ai' }));
      await store.put(consentRecord({ scope: 'web' }));
      expect(await store.remove('subject-a', 'web')).toBe(1);
      expect(await store.get('subject-a', 'web')).toBeNull();
      expect(await store.get('subject-a', 'ai')).not.toBeNull();
      expect(await store.remove('subject-a')).toBe(1);
      expect(await store.list('subject-a')).toEqual([]);
    });

    test('a numeric subject and its string form are the same subject', async () => {
      const store = await makeStore();
      await store.put(consentRecord({ subject: '42' }));
      expect(await store.get(42, 'ai')).not.toBeNull();
    });
  });
}

module.exports = { runConsentStoreContract, consentRecord };
