const path = require('path');
const { createTempProject, writeFile, writeJson } = require('./helpers');
const { assertBundleClean, assertNoLocalUrl, buildExpoExportArgs, localPublicUrls, readDotEnv, readProfileEnv } = require('../src/publish/expoExport');

describe('preparation of a remote update', () => {
  test('the profile inherits what it extends, then overrides it', () => {
    const root = createTempProject();
    writeJson(root, 'eas.json', { build: { base: { env: { A: '1', B: '1' } }, production: { extends: 'base', env: { B: '2' } } } });
    expect(readProfileEnv(root, 'production')).toEqual({ A: '1', B: '2' });
  });

  test('a missing profile, a loop and an unreadable eas.json are refused', () => {
    const root = createTempProject();
    expect(() => readProfileEnv(root, 'production')).toThrow(expect.objectContaining({ code: 'EAS_JSON_UNREADABLE' }));
    writeJson(root, 'eas.json', { build: { a: { extends: 'b' }, b: { extends: 'a' } } });
    expect(() => readProfileEnv(root, 'production')).toThrow(expect.objectContaining({ code: 'EAS_PROFILE_MISSING' }));
    expect(() => readProfileEnv(root, 'a')).toThrow(expect.objectContaining({ code: 'EAS_PROFILE_LOOP' }));
  });

  test('the .env is read with its quotes, comments ignored; absent, it is empty', () => {
    const root = createTempProject();
    expect(readDotEnv(root)).toEqual({});
    writeFile(root, '.env', '# commentaire\nEXPO_PUBLIC_API_BASE_URL="http://localhost:3000"\nexport KEY=\'x\'\n');
    expect(readDotEnv(root)).toEqual({ EXPO_PUBLIC_API_BASE_URL: 'http://localhost:3000', KEY: 'x' });
  });

  test('only public variables pointing to this machine are refused', () => {
    expect(localPublicUrls({
      EXPO_PUBLIC_A: 'http://127.0.0.1:3000',
      EXPO_PUBLIC_B: 'http://[::1]:80',
      EXPO_PUBLIC_C: 'https://api.example.com',
      EXPO_PUBLIC_D: 'not a url',
      DATABASE_URL: 'postgres://localhost/db'
    }).map((one) => one.name)).toEqual(['EXPO_PUBLIC_A', 'EXPO_PUBLIC_B']);
    expect(() => assertNoLocalUrl({ EXPO_PUBLIC_API_BASE_URL: 'http://localhost:3000' })).toThrow(expect.objectContaining({ code: 'EAS_UPDATE_LOCAL_URL' }));
    expect(() => assertNoLocalUrl({ EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com' })).not.toThrow();
  });

  test('the made bundle is read again, Hermes bytecode included', () => {
    const root = createTempProject();
    writeFile(root, 'dist/_expo/static/js/android/entry.hbc', 'xx http://127.0.0.1:3000 yy');
    writeFile(root, 'dist/assets/logo.png', 'http://127.0.0.1:3000');
    expect(() => assertBundleClean(path.join(root, 'dist'), ['http://127.0.0.1:3000'])).toThrow(expect.objectContaining({ code: 'EAS_UPDATE_LOCAL_URL_IN_BUNDLE' }));
    expect(() => assertBundleClean(path.join(root, 'dist'), ['http://10.0.0.1'])).not.toThrow();
    expect(() => assertBundleClean(path.join(root, 'dist'), [])).not.toThrow();
  });

  test('iPhone and Android only, into an absolute folder', () => {
    expect(buildExpoExportArgs({ outputDir: '/tmp/out' })).toEqual(['export', '--platform', 'ios', '--platform', 'android', '--output-dir', '/tmp/out']);
    expect(() => buildExpoExportArgs({ outputDir: 'out' })).toThrow(expect.objectContaining({ code: 'EXPO_EXPORT_OUTPUT_INVALID' }));
  });
});
