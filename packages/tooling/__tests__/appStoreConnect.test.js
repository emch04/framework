const crypto = require('crypto');
const path = require('path');
const {
  buildAltoolCommand,
  checkAscKey,
  createAscToken,
  hasAscCredentials,
  loadAscCredentials,
  parseEnvFile,
  uploadToAppStore
} = require('../src/publish/appStoreConnect');
const { decodeJwt } = require('../src/publish/jwt');
const { createTempProject, writeFile } = require('./helpers');
const { createFakeFetch, createFakeRunner, jsonResponse, testKeys } = require('./fakes');

const KEY_ID = 'ABCDE12345';
const ISSUER = '69a6de7e-1234-47e3-e053-5b8c7c11a4d1';

function setupKeyHome() {
  const home = createTempProject();
  writeFile(home, '.appstoreconnect/app.env', `# App Store Connect\nexport ASC_KEY_ID="${KEY_ID}"\nASC_ISSUER_ID=${ISSUER} # issuer\n`);
  const keyPath = writeFile(home, `.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`, testKeys().ecPem);
  return { home, keyPath };
}

describe('App Store Connect credentials', () => {
  test('parses KEY=VALUE files without running anything', () => {
    const values = parseEnvFile('A=1\nexport B="two words"\nC=\'x\'\n# D=4\nE=$(touch /tmp/pwned) \nF=val # comment\nnot a line');
    expect(values).toEqual({ A: '1', B: 'two words', C: 'x', E: '$(touch /tmp/pwned)', F: 'val' });
  });

  test('finds id, issuer and AuthKey_<id>.p8 in the default folders altool uses', () => {
    const { home, keyPath } = setupKeyHome();
    const credentials = loadAscCredentials({ envFile: '~/.appstoreconnect/app.env', homeDir: home, env: {}, cwd: home });
    expect(credentials).toEqual({ keyId: KEY_ID, issuerId: ISSUER, privateKeyPath: keyPath });
  });

  test('falls back to the process environment under configured names', () => {
    const { home, keyPath } = setupKeyHome();
    const credentials = loadAscCredentials({ keyIdEnv: 'MY_KEY', issuerIdEnv: 'MY_ISSUER', env: { MY_KEY: KEY_ID, MY_ISSUER: ISSUER }, homeDir: home, cwd: home });
    expect(credentials.privateKeyPath).toBe(keyPath);
  });

  test('missing file, bad formats and missing .p8 have distinct codes; hasAscCredentials says no', () => {
    const { home } = setupKeyHome();
    expect(() => loadAscCredentials({ envFile: path.join(home, 'nope.env'), homeDir: home, env: {} })).toThrow(expect.objectContaining({ code: 'ASC_CREDENTIALS_MISSING' }));
    expect(() => loadAscCredentials({ env: { ASC_KEY_ID: 'short', ASC_ISSUER_ID: ISSUER }, homeDir: home })).toThrow(expect.objectContaining({ code: 'ASC_CREDENTIALS_INVALID' }));
    expect(() => loadAscCredentials({ env: { ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: 'not-a-uuid' }, homeDir: home })).toThrow(expect.objectContaining({ code: 'ASC_CREDENTIALS_INVALID' }));
    expect(() => loadAscCredentials({ env: { ASC_KEY_ID: 'ZZZZZ99999', ASC_ISSUER_ID: ISSUER }, homeDir: home, cwd: home })).toThrow(expect.objectContaining({ code: 'ASC_KEY_FILE_MISSING' }));
    expect(hasAscCredentials({ envFile: path.join(home, 'nope.env'), homeDir: home, env: {} })).toBe(false);
    expect(hasAscCredentials({ envFile: '~/.appstoreconnect/app.env', homeDir: home, env: {}, cwd: home })).toBe(true);
  });
});

describe('App Store Connect token and key check', () => {
  test('ES256 token with kid, issuer, audience and a 20-minute ceiling', () => {
    const token = createAscToken({ keyId: KEY_ID, issuerId: ISSUER, privateKey: testKeys().ecPem, now: 1_700_000_000_000 });
    const jwt = decodeJwt(token);
    expect(jwt.header).toEqual({ kid: KEY_ID, alg: 'ES256', typ: 'JWT' });
    expect(jwt.payload).toEqual({ iss: ISSUER, iat: 1_700_000_000, exp: 1_700_001_200, aud: 'appstoreconnect-v1' });
    expect(crypto.verify('sha256', Buffer.from(jwt.signingInput), { key: testKeys().ec.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature)).toBe(true);
    expect(() => createAscToken({ keyId: KEY_ID, issuerId: ISSUER, privateKey: testKeys().ecPem, ttlSeconds: 3600 })).toThrow(expect.objectContaining({ code: 'ASC_TOKEN_TTL_INVALID' }));
  });

  test('a valid key: one GET /v1/apps with a bearer token', async () => {
    const { keyPath } = setupKeyHome();
    const fetch = createFakeFetch([['GET https://api.appstoreconnect.apple.com/v1/apps', jsonResponse(200, { data: [{ id: '6814477969' }] })]]);
    const result = await checkAscKey({ credentials: { keyId: KEY_ID, issuerId: ISSUER, privateKeyPath: keyPath }, fetch, bundleId: 'com.example.app' });
    expect(result).toEqual({ ok: true, status: 200, appCount: 1, appId: '6814477969' });
    expect(fetch.calls[0].url).toBe('https://api.appstoreconnect.apple.com/v1/apps?limit=1&filter%5BbundleId%5D=com.example.app');
    expect(fetch.calls[0].init.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test.each([
    [401, 'ASC_KEY_REJECTED'],
    [403, 'ASC_KEY_FORBIDDEN'],
    [500, 'ASC_CHECK_FAILED']
  ])('HTTP %s is %s', async (status, code) => {
    const fetch = createFakeFetch([['GET', jsonResponse(status, { errors: [] })]]);
    await expect(checkAscKey({ credentials: { keyId: KEY_ID, issuerId: ISSUER }, privateKey: testKeys().ecPem, fetch })).rejects.toMatchObject({ code });
  });

  test('unknown bundle id and network failure', async () => {
    const empty = createFakeFetch([['GET', jsonResponse(200, { data: [] })]]);
    await expect(checkAscKey({ credentials: { keyId: KEY_ID, issuerId: ISSUER }, privateKey: testKeys().ecPem, fetch: empty, bundleId: 'com.x.y' })).rejects.toMatchObject({ code: 'ASC_APP_NOT_FOUND' });
    await expect(checkAscKey({ credentials: { keyId: KEY_ID, issuerId: ISSUER }, privateKey: testKeys().ecPem, fetch: createFakeFetch([]) })).rejects.toMatchObject({ code: 'ASC_NETWORK' });
  });
});

describe('altool upload', () => {
  test('builds the exact argv, no shell, key folder through API_PRIVATE_KEYS_DIR', () => {
    expect(buildAltoolCommand({ filePath: '/d/App 1.ipa', keyId: KEY_ID, issuerId: ISSUER, privateKeyPath: '/keys/AuthKey_X.p8' })).toEqual({
      command: 'xcrun',
      args: ['altool', '--upload-app', '-f', '/d/App 1.ipa', '-t', 'ios', '--apiKey', KEY_ID, '--apiIssuer', ISSUER, '--output-format', 'normal'],
      env: { API_PRIVATE_KEYS_DIR: '/keys' }
    });
    expect(() => buildAltoolCommand({ filePath: '/a.ipa', keyId: KEY_ID, issuerId: ISSUER, platform: 'android' })).toThrow(expect.objectContaining({ code: 'ASC_PLATFORM_INVALID' }));
    expect(() => buildAltoolCommand({ filePath: '/a.ipa', keyId: 'x;rm', issuerId: ISSUER })).toThrow(expect.objectContaining({ code: 'ASC_CREDENTIALS_INVALID' }));
  });

  test('runs altool and hides the issuer and key id from its output', async () => {
    const dir = createTempProject();
    const file = writeFile(dir, 'App.ipa', 'ipa');
    const lines = [];
    const run = createFakeRunner(() => ({ code: 0, stdout: `Using key ${KEY_ID} issuer ${ISSUER}\nUPLOAD SUCCEEDED` }));
    await uploadToAppStore({ filePath: file, credentials: { keyId: KEY_ID, issuerId: ISSUER, privateKeyPath: '/k/AuthKey.p8' }, runProcess: run, onLine: (line) => lines.push(line), env: {} });
    expect(run.calls[0].options.env.API_PRIVATE_KEYS_DIR).toBe('/k');
    expect(lines.join('\n')).not.toContain(ISSUER);
    expect(lines.join('\n')).not.toContain(KEY_ID);
    expect(lines).toContain('UPLOAD SUCCEEDED');
  });

  test('an ITMS error fails the upload even when altool exits 0', async () => {
    const dir = createTempProject();
    const file = writeFile(dir, 'App.ipa', 'ipa');
    const run = createFakeRunner(() => ({ code: 0, stdout: 'ERROR ITMS-90189: "Redundant Binary Upload"' }));
    await expect(uploadToAppStore({ filePath: file, credentials: { keyId: KEY_ID, issuerId: ISSUER }, runProcess: run })).rejects.toMatchObject({ code: 'ASC_UPLOAD_FAILED', message: expect.stringContaining('ITMS-90189') });
    const failing = createFakeRunner(() => ({ code: 1 }));
    await expect(uploadToAppStore({ filePath: file, credentials: { keyId: KEY_ID, issuerId: ISSUER }, runProcess: failing })).rejects.toMatchObject({ code: 'ASC_UPLOAD_FAILED' });
  });
});
