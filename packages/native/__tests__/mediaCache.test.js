const {
  MEDIA_CACHE_ABANDONED_MS,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_CACHE_MAX_FILES,
  contentKey,
  extensionFor,
  planEviction,
  createMediaCache
} = require('../src');

const NOW = 1_800_000_000_000;
const MB = 1024 * 1024;
const EXTENSIONS = ['m4a', 'wav'];
const file = (name, size, ageMs) => ({ name, size, modifiedAt: NOW - ageMs });
const plan = (files, options = {}) => planEviction(files, { extensions: EXTENSIONS, now: NOW, ...options });

describe('contentKey', () => {
  test('the same content lands on the same file', () => {
    expect(contentKey('v2', 'fr', 'Hello everyone')).toBe(contentKey('v2', 'fr', 'Hello everyone'));
    expect(contentKey('v2', null, 'Hi')).toBe(contentKey('v2', undefined, 'Hi'));
  });

  test('only file-name-safe characters', () => {
    expect(contentKey('What is it? / \\ : *', 'fr')).toMatch(/^[a-z0-9-]+$/);
  });

  test('one character of difference gives another key', () => {
    expect(contentKey('The average is 12')).not.toBe(contentKey('The average is 13'));
    expect(contentKey('ab')).not.toBe(contentKey('ba'));
    const long = 'x'.repeat(5000);
    expect(contentKey(`${long}a`)).not.toBe(contentKey(`${long}b`));
  });

  test('every part counts: a version bump retires the old files', () => {
    expect(contentKey('v1', 'Hi')).not.toBe(contentKey('v2', 'Hi'));
    expect(contentKey('v1', 'fr', 'Hi')).not.toBe(contentKey('v1', 'en', 'Hi'));
  });

  test('parts are not merely glued together', () => {
    expect(contentKey('a:b', 'c')).not.toBe(contentKey('a', 'b:c'));
    expect(contentKey('ab', '')).not.toBe(contentKey('a', 'b'));
  });

  test('no collision across thousands of neighbouring contents', () => {
    const seen = new Set();
    for (let i = 0; i < 20000; i += 1) seen.add(contentKey('v1', i % 2 ? 'fr' : null, `Answer number ${i}`));
    expect(seen.size).toBe(20000);
  });
});

describe('extensionFor', () => {
  const AUDIO = { 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a' };
  test('the Content-Type decides, parameters and case ignored', () => {
    expect(extensionFor('audio/mp4', AUDIO, 'wav')).toBe('m4a');
    expect(extensionFor('Audio/MP4; codecs=mp4a.40.2', AUDIO, 'wav')).toBe('m4a');
    expect(extensionFor('audio/x-m4a', AUDIO, 'wav')).toBe('m4a');
  });

  test('anything unlisted — or missing — takes the fallback', () => {
    expect(extensionFor('audio/wav', AUDIO, 'wav')).toBe('wav');
    expect(extensionFor(null, AUDIO, 'wav')).toBe('wav');
    expect(extensionFor('', AUDIO, 'wav')).toBe('wav');
    expect(extensionFor('toString', AUDIO, 'wav')).toBe('wav');
  });
});

describe('planEviction', () => {
  test('under both bounds, nothing goes', () => {
    const files = Array.from({ length: MEDIA_CACHE_MAX_FILES }, (_, i) => file(`s${i}.m4a`, 100_000, i * 1000));
    expect(plan(files)).toEqual([]);
  });

  test('past the file count, the oldest go, and only them', () => {
    const files = Array.from({ length: MEDIA_CACHE_MAX_FILES + 3 }, (_, i) => file(`s${i}.m4a`, 1000, i * 1000));
    files.reverse(); // disk order says nothing about age
    expect(plan(files).sort()).toEqual(
      [`s${MEDIA_CACHE_MAX_FILES}.m4a`, `s${MEDIA_CACHE_MAX_FILES + 1}.m4a`, `s${MEDIA_CACHE_MAX_FILES + 2}.m4a`].sort()
    );
  });

  test('past the byte budget, the oldest go until back under it', () => {
    const files = [
      file('recent.wav', 25 * MB, 1000),
      file('middle.wav', 25 * MB, 2000),
      file('old.wav', 25 * MB, 3000),
      file('older.m4a', 1 * MB, 4000)
    ];
    const discarded = plan(files);
    expect(discarded.sort()).toEqual(['old.wav', 'older.m4a']);
    const kept = files.filter((f) => !discarded.includes(f.name));
    expect(kept.reduce((total, f) => total + f.size, 0)).toBeLessThanOrEqual(MEDIA_CACHE_MAX_BYTES);
  });

  test('exactly at the byte budget, everything stays', () => {
    const files = [file('a.wav', MEDIA_CACHE_MAX_BYTES / 2, 1000), file('b.wav', MEDIA_CACHE_MAX_BYTES / 2, 2000)];
    expect(plan(files)).toEqual([]);
  });

  test('the newest is never discarded, even too heavy on its own', () => {
    const files = [file('huge.wav', MEDIA_CACHE_MAX_BYTES * 2, 1000), file('small.m4a', 1000, 5000)];
    expect(plan(files)).toEqual(['small.m4a']);
  });

  test('an abandoned temporary goes; one being written stays and does not count', () => {
    const files = [
      file('abc.123.tmp', 50 * MB, MEDIA_CACHE_ABANDONED_MS + 1000),
      file('def.456.tmp', 50 * MB, 1000),
      file('s1.m4a', 20 * MB, 2000),
      file('s2.m4a', 20 * MB, 3000)
    ];
    expect(plan(files)).toEqual(['abc.123.tmp']);
  });

  test('the bounds are settings', () => {
    const files = [file('a.m4a', 10, 1), file('b.m4a', 10, 2), file('c.m4a', 10, 3)];
    expect(plan(files, { maxFiles: 2 })).toEqual(['c.m4a']);
    expect(plan(files, { maxBytes: 15 })).toEqual(['b.m4a', 'c.m4a']);
    expect(plan([file('x.tmp', 1, 20)], { abandonedAfterMs: 10 })).toEqual(['x.tmp']);
  });
});

/* expo-file-system/legacy, in memory: modificationTime in seconds, as Expo. */
function memoryFs(clock) {
  const files = new Map();
  const dirs = new Set();
  const fs = {
    files,
    failMove: false,
    async getInfoAsync(uri) {
      if (dirs.has(uri)) return { exists: true, isDirectory: true };
      const entry = files.get(uri);
      if (!entry) return { exists: false };
      return { exists: true, isDirectory: false, size: entry.data.length, modificationTime: entry.mtime / 1000 };
    },
    async makeDirectoryAsync(uri) {
      dirs.add(uri);
    },
    async writeAsStringAsync(uri, data) {
      files.set(uri, { data, mtime: clock() });
    },
    async moveAsync({ from, to }) {
      if (fs.failMove) throw new Error('move failed');
      const entry = files.get(from);
      if (!entry) throw new Error('missing');
      files.delete(from);
      files.set(to, entry);
    },
    async deleteAsync(uri) {
      files.delete(uri);
    },
    async readDirectoryAsync(uri) {
      return [...files.keys()].filter((key) => key.startsWith(uri)).map((key) => key.slice(uri.length));
    }
  };
  return fs;
}

describe('createMediaCache', () => {
  let clock;
  let fs;
  let cache;
  const now = () => clock;

  beforeEach(() => {
    clock = NOW;
    fs = memoryFs(now);
    cache = createMediaCache({ fs, directory: 'file:///cache/media', extensions: EXTENSIONS, now });
  });

  const writer = (data) => (uri) => fs.writeAsStringAsync(uri, data);

  test('a miss downloads once; a hit replays from disk', async () => {
    const download = jest.fn(async () => ({ extension: 'm4a', write: writer('bytes') }));
    const first = await cache.resolve('k1', download);
    const second = await cache.resolve('k1', download);
    expect(first).toBe('file:///cache/media/k1.m4a');
    expect(second).toBe(first);
    expect(download).toHaveBeenCalledTimes(1);
  });

  test('a lookup finds the file whatever extension it was stored under', async () => {
    await cache.store('k2', 'wav', writer('x'));
    await expect(cache.lookup('k2')).resolves.toBe('file:///cache/media/k2.wav');
    await expect(cache.lookup('missing')).resolves.toBeNull();
  });

  test('bytes land under a temporary name, and only the move makes them visible', async () => {
    let seenDuringWrite = null;
    await cache.store('k3', 'm4a', async (tempUri) => {
      expect(tempUri).toMatch(/\.tmp$/);
      await fs.writeAsStringAsync(tempUri, 'partial');
      seenDuringWrite = await cache.lookup('k3');
    });
    expect(seenDuringWrite).toBeNull();
    expect([...fs.files.keys()]).toEqual(['file:///cache/media/k3.m4a']);
  });

  test('an interrupted write leaves no finished file, and no temporary behind', async () => {
    await expect(
      cache.store('k4', 'm4a', async (tempUri) => {
        await fs.writeAsStringAsync(tempUri, 'half');
        throw new Error('network lost');
      })
    ).rejects.toThrow('network lost');
    await expect(cache.lookup('k4')).resolves.toBeNull();
    expect(fs.files.size).toBe(0);
  });

  test('a lost race keeps the winner: the move fails, the finished file is there', async () => {
    await cache.store('k5', 'm4a', writer('first'));
    fs.failMove = true;
    await expect(cache.store('k5', 'm4a', writer('second'))).resolves.toBe('file:///cache/media/k5.m4a');
    expect([...fs.files.keys()]).toEqual(['file:///cache/media/k5.m4a']);
  });

  test('a failed move with no finished file is an error', async () => {
    fs.failMove = true;
    await expect(cache.store('k6', 'm4a', writer('x'))).rejects.toThrow('move failed');
    expect(fs.files.size).toBe(0);
  });

  test('an extension the cache would never look up is refused', async () => {
    await expect(cache.store('k7', 'mp3', writer('x'))).rejects.toThrow(/mp3/);
  });

  test('tidy() applies the bounds to what is on disk', async () => {
    const small = createMediaCache({ fs, directory: 'file:///cache/media/', extensions: EXTENSIONS, maxFiles: 2, now });
    for (const key of ['a', 'b', 'c']) {
      clock += 1000;
      await small.store(key, 'm4a', writer('x'));
    }
    await small.tidy();
    expect([...fs.files.keys()].sort()).toEqual(['file:///cache/media/b.m4a', 'file:///cache/media/c.m4a']);
  });

  test('tidy() collects an abandoned temporary', async () => {
    fs.files.set('file:///cache/media/z.1.tmp', { data: 'x', mtime: NOW - MEDIA_CACHE_ABANDONED_MS - 1000 });
    fs.files.set('file:///cache/media/y.2.tmp', { data: 'x', mtime: NOW - 1000 });
    await fs.makeDirectoryAsync('file:///cache/media/');
    await expect(cache.tidy()).resolves.toEqual(['z.1.tmp']);
  });

  test('two tidies at once share one pass', async () => {
    await fs.makeDirectoryAsync('file:///cache/media/');
    expect(cache.tidy()).toBe(cache.tidy());
  });

  test('tidy() on a directory that does not exist yet is a no-op', async () => {
    await expect(cache.tidy()).resolves.toEqual([]);
  });

  test('the adapter, the directory and the extensions are required', () => {
    expect(() => createMediaCache({ directory: 'd', extensions: ['a'] })).toThrow(/fs/);
    expect(() => createMediaCache({ fs, extensions: ['a'] })).toThrow(/directory/);
    expect(() => createMediaCache({ fs, directory: 'd' })).toThrow(/extension/);
  });
});
