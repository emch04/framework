const fs = require('fs');
const path = require('path');
const {
  computeFingerprint,
  decideVersionBump,
  readPublishedFingerprint,
  readRuntimeVersionPolicy,
  recordPublishedFingerprint
} = require('../src/publish/fingerprint');
const { applyVersionBump, bumpVersion } = require('../src/publish/version');
const { createTempProject, writeFile, writeJson } = require('./helpers');

describe('native fingerprint decision', () => {
  test('first build ever: no published fingerprint means a new version', () => {
    expect(decideVersionBump({ current: 'abc', published: null })).toEqual({ bump: true, reason: 'no-published-fingerprint' });
  });

  test('native changed since the last published build: bump', () => {
    expect(decideVersionBump({ current: 'new', published: 'old' })).toEqual({ bump: true, reason: 'native-changed' });
  });

  test('same native (trailing newline of the file ignored): no bump', () => {
    expect(decideVersionBump({ current: 'abc', published: 'abc\n' })).toEqual({ bump: false, reason: 'native-unchanged' });
  });

  test('an empty current fingerprint is an error, never "changed"', () => {
    expect(() => decideVersionBump({ current: '', published: 'abc' })).toThrow(expect.objectContaining({ code: 'FINGERPRINT_EMPTY' }));
  });

  test('records then reads back the published fingerprint', () => {
    const file = path.join(createTempProject(), 'scripts', '.fp');
    expect(readPublishedFingerprint(file)).toBeNull();
    recordPublishedFingerprint(file, ' f00d ');
    expect(fs.readFileSync(file, 'utf8')).toBe('f00d\n');
    expect(readPublishedFingerprint(file)).toBe('f00d');
    expect(() => recordPublishedFingerprint(file, '')).toThrow(expect.objectContaining({ code: 'FINGERPRINT_EMPTY' }));
  });

  test('computes through an injected function, string or { hash }', async () => {
    await expect(computeFingerprint('/p', { compute: async () => 'h1' })).resolves.toBe('h1');
    await expect(computeFingerprint('/p', { compute: async () => ({ hash: 'h2', sources: [] }) })).resolves.toBe('h2');
  });

  test('computes through a configured command printing @expo/fingerprint JSON', async () => {
    const calls = [];
    const runProcess = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { code: 0, stdout: JSON.stringify({ hash: 'cli-hash', sources: [] }) };
    };
    await expect(computeFingerprint('/proj', { command: ['npx', '@expo/fingerprint', '.'], runProcess })).resolves.toBe('cli-hash');
    expect(calls).toEqual([{ command: 'npx', args: ['@expo/fingerprint', '.'], cwd: '/proj' }]);
  });

  test('a failing or non-JSON fingerprint command fails loudly', async () => {
    await expect(computeFingerprint('/p', { command: ['x'], runProcess: async () => ({ code: 1, stdout: '' }) }))
      .rejects.toMatchObject({ code: 'FINGERPRINT_FAILED' });
    await expect(computeFingerprint('/p', { command: ['x'], runProcess: async () => ({ code: 0, stdout: 'npm WARN' }) }))
      .rejects.toMatchObject({ code: 'FINGERPRINT_FAILED' });
  });

  test('uses the optional @expo/fingerprint peer, and says so when it is absent', async () => {
    const loaded = { createFingerprintAsync: async (dir) => ({ hash: `peer:${dir}` }) };
    await expect(computeFingerprint('/app', { loadModule: () => loaded })).resolves.toBe('peer:/app');
    await expect(computeFingerprint('/app', { loadModule: () => null })).rejects.toMatchObject({ code: 'FINGERPRINT_UNAVAILABLE' });
  });

  test('reads the runtimeVersion policy from app.json', () => {
    const dir = createTempProject();
    expect(readRuntimeVersionPolicy(dir)).toBe('unknown');
    writeJson(dir, 'app.json', { expo: { runtimeVersion: { policy: 'appVersion' } } });
    expect(readRuntimeVersionPolicy(dir)).toBe('appVersion');
    writeJson(dir, 'app.json', { expo: { runtimeVersion: '1.0.0' } });
    expect(readRuntimeVersionPolicy(dir)).toBe('fixed');
    writeJson(dir, 'app.json', { expo: {} });
    expect(readRuntimeVersionPolicy(dir)).toBe('unset');
  });
});

describe('version bump', () => {
  test.each([
    ['1.1.5', 'patch', '1.1.6'],
    ['1.1.9', 'patch', '1.1.10'],
    ['1.2.0-beta.1', 'patch', '1.2.0'],
    ['1.1.5', 'minor', '1.2.0'],
    ['1.2.0-rc.1', 'minor', '1.2.0'],
    ['1.1.5', 'major', '2.0.0'],
    ['2.0.0-alpha', 'major', '2.0.0']
  ])('%s + %s = %s (same as npm version)', (from, level, to) => {
    expect(bumpVersion(from, level)).toBe(to);
  });

  test('rejects unreadable versions and levels', () => {
    expect(() => bumpVersion('v1.2', 'patch')).toThrow(expect.objectContaining({ code: 'VERSION_INVALID' }));
    expect(() => bumpVersion('1.2.3', 'huge')).toThrow(expect.objectContaining({ code: 'VERSION_LEVEL_INVALID' }));
  });

  test('rewrites package.json and package-lock.json, keeping indentation', () => {
    const dir = createTempProject();
    writeFile(dir, 'package.json', '{\n    "name": "app",\n    "version": "1.1.5"\n}\n');
    writeJson(dir, 'package-lock.json', { name: 'app', version: '1.1.5', lockfileVersion: 3, packages: { '': { version: '1.1.5' } } });

    const result = applyVersionBump(dir, 'patch');

    expect(result).toMatchObject({ from: '1.1.5', to: '1.1.6' });
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe('{\n    "name": "app",\n    "version": "1.1.6"\n}\n');
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    expect(lock.version).toBe('1.1.6');
    expect(lock.packages[''].version).toBe('1.1.6');
  });
});
