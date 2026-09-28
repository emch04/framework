const crypto = require('crypto');
const { URLSearchParams } = require('url');
const { createGooglePlayClient, loadServiceAccount, PLAY_SCOPE } = require('../src/publish/googlePlay');
const { decodeJwt } = require('../src/publish/jwt');
const { createTempProject, writeFile, writeJson } = require('./helpers');
const { createFakeFetch, jsonResponse, testKeys } = require('./fakes');

const PACKAGE = 'com.example.app';
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;
/* Assemblé à l'exécution : un faux jeton écrit tel quel ressemble à un vrai pour les scanners de secrets. */
const ACCESS_TOKEN = ['ya29', 'super-secret-access-token'].join('.');

function serviceAccount() {
  return { client_email: 'publisher@example.iam.gserviceaccount.com', private_key: testKeys().rsaPem, token_uri: 'https://oauth2.googleapis.com/token' };
}

function happyRoutes(overrides = {}) {
  return [
    ['POST https://oauth2.googleapis.com/token', overrides.token || jsonResponse(200, { access_token: ACCESS_TOKEN, expires_in: 3599 })],
    [`POST ${API}/edits/edit-1:commit`, overrides.commit || jsonResponse(200, { id: 'edit-1' })],
    [`POST ${API}/edits`, overrides.edit || jsonResponse(200, { id: 'edit-1' })],
    [`POST ${UPLOAD}/edits/edit-1/bundles?uploadType=media`, overrides.upload || jsonResponse(200, { versionCode: 42, sha256: 'x' })],
    [`PUT ${API}/edits/edit-1/tracks/`, overrides.track || jsonResponse(200, {})],
    [`DELETE ${API}/edits/edit-1`, jsonResponse(204)]
  ];
}

describe('Google Play upload client', () => {
  test('runs the edits flow in order: token, edit, bundle, track, commit', async () => {
    const fetch = createFakeFetch(happyRoutes());
    const client = createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch, now: () => 1_700_000_000_000 });

    const result = await client.uploadBundle({ body: Buffer.from('aab-bytes') });

    expect(result).toEqual({ versionCode: 42, editId: 'edit-1', track: 'internal', packageName: PACKAGE });
    expect(fetch.calls.map((call) => `${call.method} ${call.url.replace(API, 'API').replace(UPLOAD, 'UPLOAD')}`)).toEqual([
      'POST https://oauth2.googleapis.com/token',
      'POST API/edits',
      'POST UPLOAD/edits/edit-1/bundles?uploadType=media',
      'PUT API/edits/edit-1/tracks/internal',
      'POST API/edits/edit-1:commit'
    ]);
    expect(fetch.calls[2].init.headers['content-type']).toBe('application/octet-stream');
    expect(fetch.calls[2].init.body.toString()).toBe('aab-bytes');
    expect(JSON.parse(fetch.calls[3].init.body)).toEqual({ track: 'internal', releases: [{ status: 'completed', versionCodes: ['42'] }] });
    for (const call of fetch.calls.slice(1)) {
      expect(call.init.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    }
  });

  test('the token request carries an RS256 assertion with the Play scope, signed by the service account', async () => {
    const fetch = createFakeFetch(happyRoutes());
    const client = createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch, now: () => 1_700_000_000_000 });
    await client.getAccessToken();

    const form = new URLSearchParams(fetch.calls[0].init.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const jwt = decodeJwt(form.get('assertion'));
    expect(jwt.header.alg).toBe('RS256');
    expect(jwt.payload).toEqual({
      iss: 'publisher@example.iam.gserviceaccount.com',
      scope: PLAY_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600
    });
    expect(crypto.verify('sha256', Buffer.from(jwt.signingInput), testKeys().rsa.publicKey, jwt.signature)).toBe(true);
  });

  test('custom track, draft status, release name and review flag are passed through', async () => {
    const fetch = createFakeFetch(happyRoutes());
    const client = createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch });
    await client.uploadBundle({ body: Buffer.from('x'), track: 'beta', releaseStatus: 'draft', releaseName: '1.2.0 (42)', changesNotSentForReview: true });

    const trackCall = fetch.calls.find((call) => call.method === 'PUT');
    expect(trackCall.url).toBe(`${API}/edits/edit-1/tracks/beta`);
    expect(JSON.parse(trackCall.init.body).releases[0]).toEqual({ status: 'draft', versionCodes: ['42'], name: '1.2.0 (42)' });
    expect(fetch.calls[fetch.calls.length - 1].url).toBe(`${API}/edits/edit-1:commit?changesNotSentForReview=true`);
  });

  test('a refused key gives PLAY_TOKEN_REFUSED and never the token or key', async () => {
    const fetch = createFakeFetch(happyRoutes({ token: jsonResponse(400, { error: 'invalid_grant' }) }));
    const client = createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch });

    const error = await client.uploadBundle({ body: Buffer.from('x') }).catch((caught) => caught);
    expect(error.code).toBe('PLAY_TOKEN_REFUSED');
    expect(error.message).toContain('400');
    expect(error.message).not.toMatch(/PRIVATE KEY/);
  });

  test.each([
    ['edit', 'PLAY_EDIT_FAILED'],
    ['upload', 'PLAY_UPLOAD_FAILED'],
    ['track', 'PLAY_TRACK_FAILED'],
    ['commit', 'PLAY_COMMIT_FAILED']
  ])('a failure at %s is reported as %s with Google\'s own reason', async (step, code) => {
    const fetch = createFakeFetch(happyRoutes({ [step]: jsonResponse(403, { error: { message: 'APK specifies a version code that has already been used.' } }) }));
    const client = createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch });

    const error = await client.uploadBundle({ body: Buffer.from('x') }).catch((caught) => caught);
    expect(error.code).toBe(code);
    expect(error.message).toBe('Google Play a repondu 403 : APK specifies a version code that has already been used.');
    expect(error.message).not.toContain(ACCESS_TOKEN);
  });

  test('an edit opened before a failure is deleted, and only then is the error raised', async () => {
    const fetch = createFakeFetch(happyRoutes({ upload: jsonResponse(500, { error: { message: 'backend' } }) }));
    const client = createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch });

    await expect(client.uploadBundle({ body: Buffer.from('x') })).rejects.toMatchObject({ code: 'PLAY_UPLOAD_FAILED' });
    expect(fetch.calls[fetch.calls.length - 1]).toMatchObject({ method: 'DELETE', url: `${API}/edits/edit-1` });
  });

  test('an error text echoing a bearer token is masked', async () => {
    const fetch = createFakeFetch(happyRoutes({ track: jsonResponse(401, { error: { message: `Invalid Bearer ${ACCESS_TOKEN}` } }) }));
    const client = createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch });
    const error = await client.uploadBundle({ body: Buffer.from('x') }).catch((caught) => caught);
    expect(error.message).toContain('Bearer ***');
    expect(error.message).not.toContain(ACCESS_TOKEN);
  });

  test('network failure is PLAY_NETWORK', async () => {
    const client = createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch: createFakeFetch([]) });
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'PLAY_NETWORK' });
  });

  test('validates package name, track, release status and bundle file before any call', async () => {
    const fetch = createFakeFetch(happyRoutes());
    expect(() => createGooglePlayClient({ packageName: 'not a package', serviceAccount: serviceAccount(), fetch })).toThrow(expect.objectContaining({ code: 'PLAY_PACKAGE_INVALID' }));
    const client = createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch });
    await expect(client.uploadBundle({ body: Buffer.from('x'), track: '../x' })).rejects.toMatchObject({ code: 'PLAY_TRACK_INVALID' });
    await expect(client.uploadBundle({ body: Buffer.from('x'), releaseStatus: 'live' })).rejects.toMatchObject({ code: 'PLAY_RELEASE_STATUS_INVALID' });
    await expect(client.uploadBundle({ body: Buffer.from('x'), releaseStatus: 'inProgress' })).rejects.toMatchObject({ code: 'PLAY_RELEASE_STATUS_INVALID' });
    await expect(client.uploadBundle({ filePath: '/nope/app.aab' })).rejects.toMatchObject({ code: 'PLAY_BUNDLE_MISSING' });
    expect(fetch.calls).toHaveLength(0);
  });

  test('reads the bundle from disk when given a path', async () => {
    const dir = createTempProject();
    const file = writeFile(dir, 'app.aab', 'bundle-on-disk');
    const fetch = createFakeFetch(happyRoutes());
    await createGooglePlayClient({ packageName: PACKAGE, serviceAccount: serviceAccount(), fetch }).uploadBundle({ filePath: file });
    expect(fetch.calls[2].init.body.toString()).toBe('bundle-on-disk');
  });
});

describe('service account loading', () => {
  test('from a file path, token_uri defaulted', () => {
    const dir = createTempProject();
    writeJson(dir, 'sa.json', { client_email: 'x@y.iam', private_key: 'PEM' });
    expect(loadServiceAccount({ path: `${dir}/sa.json` })).toEqual({ client_email: 'x@y.iam', private_key: 'PEM', token_uri: 'https://oauth2.googleapis.com/token' });
  });

  test('from an environment variable name', () => {
    const env = { PLAY_KEY_JSON: JSON.stringify({ client_email: 'x@y.iam', private_key: 'PEM', token_uri: 'https://t' }) };
    expect(loadServiceAccount({ jsonEnv: 'PLAY_KEY_JSON', env }).token_uri).toBe('https://t');
  });

  test('missing, unparsable or incomplete keys have distinct codes and never echo content', () => {
    expect(() => loadServiceAccount({})).toThrow(expect.objectContaining({ code: 'PLAY_KEY_MISSING' }));
    expect(() => loadServiceAccount({ path: '/nope.json' })).toThrow(expect.objectContaining({ code: 'PLAY_KEY_MISSING' }));
    expect(() => loadServiceAccount({ jsonEnv: 'EMPTY', env: {} })).toThrow(expect.objectContaining({ code: 'PLAY_KEY_MISSING' }));
    let error;
    try {
      loadServiceAccount({ jsonEnv: 'K', env: { K: '{"private_key": "TOPSECRET"' } });
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('PLAY_KEY_INVALID');
    expect(error.message).not.toContain('TOPSECRET');
    expect(() => loadServiceAccount({ jsonEnv: 'K', env: { K: '{"client_email":"a"}' } })).toThrow(expect.objectContaining({ code: 'PLAY_KEY_INVALID' }));
  });
});
