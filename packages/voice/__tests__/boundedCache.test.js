const { createBoundedVoiceCache, createProviderVoiceService, createVoiceService } = require('../src');

const entry = (text) => ({ audio: Buffer.from(text), format: 'wav', mimeType: 'audio/wav' });

describe('bounded voice cache', () => {
  test('keeps at most maxEntries readings, the least recently used leaving first', async () => {
    const cache = createBoundedVoiceCache({ maxEntries: 2 });
    await cache.set('a', entry('aa'));
    await cache.set('b', entry('bb'));
    await cache.get('a'); // a is heard again: b is now the oldest
    await cache.set('c', entry('cc'));
    expect(cache.size).toBe(2);
    expect(await cache.get('b')).toBeNull();
    expect((await cache.get('a')).audio.toString()).toBe('aa');
    expect((await cache.get('c')).audio.toString()).toBe('cc');
  });

  test('keeps at most maxBytes of audio, and refuses a reading bigger than that', async () => {
    const cache = createBoundedVoiceCache({ maxBytes: 10 });
    await cache.set('a', entry('1234'));
    await cache.set('b', entry('5678'));
    expect(cache.bytes).toBe(8);
    await cache.set('c', entry('abcd')); // 12 bytes: a leaves
    expect(await cache.get('a')).toBeNull();
    expect(cache.bytes).toBe(8);
    await cache.set('huge', entry('x'.repeat(11)));
    expect(await cache.get('huge')).toBeNull();
    expect(cache.size).toBe(2);
  });

  test('both limits together; replacing a key does not count twice', async () => {
    const cache = createBoundedVoiceCache({ maxEntries: 3, maxBytes: 6 });
    await cache.set('a', entry('12'));
    await cache.set('a', entry('123'));
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(3);
    await cache.set('b', entry('123'));
    await cache.set('c', entry('1'));
    expect(cache.size).toBe(2);
    expect(await cache.get('a')).toBeNull();
    expect(cache.bytes).toBe(4);
  });

  test('with no limit it still holds a few hundred readings, not everything', async () => {
    const cache = createBoundedVoiceCache();
    for (let i = 0; i < 300; i += 1) await cache.set(`k${i}`, entry('x'));
    expect(cache.size).toBe(256);
    expect(await cache.get('k0')).toBeNull();
    expect(await cache.get('k299')).not.toBeNull();
  });

  test('a time to live is honoured; none means until evicted', async () => {
    let clock = 1000;
    const cache = createBoundedVoiceCache({ maxEntries: 5, now: () => clock });
    await cache.set('short', entry('s'), 10);
    await cache.set('forever', entry('f'));
    await cache.set('zero', entry('z'), 0);
    clock += 9999;
    expect(await cache.get('short')).not.toBeNull();
    clock += 2;
    expect(await cache.get('short')).toBeNull();
    expect(cache.size).toBe(2);
    expect(await cache.get('forever')).not.toBeNull();
    expect(await cache.get('zero')).not.toBeNull();
  });

  test('what comes out is a copy, delete and clear work, bytes stay exact', async () => {
    const cache = createBoundedVoiceCache({ maxEntries: 3 });
    const source = entry('abc');
    await cache.set('a', source);
    source.audio[0] = 0;
    const got = await cache.get('a');
    expect(got.audio.toString()).toBe('abc');
    got.audio[0] = 0;
    expect((await cache.get('a')).audio.toString()).toBe('abc');
    expect(await cache.delete('a')).toBe(true);
    expect(await cache.delete('a')).toBe(false);
    expect(cache.bytes).toBe(0);
    await cache.set('b', entry('x'));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  test('limits are checked', () => {
    expect(() => createBoundedVoiceCache({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => createBoundedVoiceCache({ maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => createBoundedVoiceCache({ maxEntries: 'many' })).toThrow(/maxEntries/);
  });

  test('it serves as the cache of the provider chain: a phrase heard again costs nothing, an old one leaves', async () => {
    const cache = createBoundedVoiceCache({ maxEntries: 2 });
    const synthesize = jest.fn(async ({ text }) => entry(text));
    const service = createProviderVoiceService({ providers: [{ id: 'p', synthesize }], cache });
    await service.synthesize({ text: 'one' });
    await service.synthesize({ text: 'two' });
    expect((await service.synthesize({ text: 'one' })).cached).toBe(true);
    await service.synthesize({ text: 'three' }); // two is the least recently used
    expect((await service.synthesize({ text: 'one' })).cached).toBe(true);
    expect((await service.synthesize({ text: 'two' })).cached).toBe(false);
    expect(synthesize).toHaveBeenCalledTimes(4);
  });

  test('it is accepted by the command-line service', () => {
    const cache = createBoundedVoiceCache({ maxBytes: 1024 });
    expect(() => createVoiceService({
      spawn: () => ({}), filesystem: { readFile: async () => Buffer.alloc(0), rename: async () => {}, remove: async () => {} }, cache, models: { en: 'x' }
    })).not.toThrow();
  });
});
