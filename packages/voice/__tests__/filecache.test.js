const { mkdtemp, readdir, readFile, stat, utimes, writeFile, mkdir, rename, rm } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const { createFileVoiceCache } = require('../src');

const filesystem = {
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  readFile,
  writeFile,
  rename,
  remove: (path) => rm(path, { force: true }),
  list: readdir,
  modifiedAt: async (path) => (await stat(path)).mtimeMs,
  touch: (path) => utimes(path, new Date(), new Date())
};
const DAY = 86400000;

test('a reading is kept whole under its key and read back as finished audio', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'voice-file-cache-')), 'voice');
  const cache = createFileVoiceCache({ filesystem, directory, initialFiles: { '.gitignore': '*\n' } });
  expect(await cache.get('a'.repeat(64))).toBeNull();
  await cache.set('a'.repeat(64), { audio: Buffer.from('AAC') });
  expect(await cache.get('a'.repeat(64))).toEqual({ audio: Buffer.from('AAC'), format: 'm4a', mimeType: 'audio/mp4' });
  expect((await readdir(directory)).sort()).toEqual(['.gitignore', `${'a'.repeat(64)}.m4a`]);
  expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('*\n');
});
test('only a key reads a file: a path is not a key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-file-cache-'));
  const cache = createFileVoiceCache({ filesystem, directory });
  expect(await cache.get('../../etc/passwd')).toBeNull();
  expect(await cache.get('a.b')).toBeNull();
  await expect(cache.set('../x', { audio: Buffer.from('x') })).rejects.toThrow('invalid key');
  expect(await cache.delete('../x')).toBe(false);
});
test('the readings not heard for sixty days leave; each one heard again stays', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-file-cache-'));
  const cache = createFileVoiceCache({ filesystem, directory });
  const now = Date.now();
  for (const [name, days] of [['old', 61], ['heard', 61], ['recent', 10]]) {
    await writeFile(join(directory, `${name}.m4a`), 'AAC');
    const when = new Date(now - days * DAY);
    await utimes(join(directory, `${name}.m4a`), when, when);
  }
  await writeFile(join(directory, '.gitignore'), '*\n');
  await cache.get('heard');
  expect(await cache.prune(now)).toBe(1);
  expect((await readdir(directory)).sort()).toEqual(['.gitignore', 'heard.m4a', 'recent.m4a']);
});
test('a write prunes by itself, at most once in the delay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-file-cache-'));
  let clock = Date.now();
  const cache = createFileVoiceCache({ filesystem, directory, now: () => clock, pruneEveryMs: 1000 });
  await writeFile(join(directory, 'stale.m4a'), 'AAC');
  const past = new Date(clock - 90 * DAY);
  await utimes(join(directory, 'stale.m4a'), past, past);
  await cache.set('first', { audio: Buffer.from('1') });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect((await readdir(directory)).sort()).toEqual(['first.m4a']);
  await writeFile(join(directory, 'stale2.m4a'), 'AAC');
  await utimes(join(directory, 'stale2.m4a'), past, past);
  clock += 500;
  await cache.set('second', { audio: Buffer.from('2') });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect((await readdir(directory)).sort()).toContain('stale2.m4a');
  clock += 600;
  await cache.set('third', { audio: Buffer.from('3') });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect((await readdir(directory)).sort()).not.toContain('stale2.m4a');
});
test('the file system must be complete', () => {
  expect(() => createFileVoiceCache({ directory: '/x' })).toThrow('filesystem is required');
  expect(() => createFileVoiceCache({ filesystem: { readFile }, directory: '/x' })).toThrow('filesystem.mkdir must be a function');
  expect(() => createFileVoiceCache({ filesystem })).toThrow('directory is required');
});
