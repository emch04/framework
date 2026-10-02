const fs = require('fs');
const path = require('path');
const { runPublish, runPublishFingerprint, runPublishUpload, runPublishCheckIos } = require('../src/commands/publish');
const { runCli } = require('../src/cli');
const { createOutput, createTempProject, writeFile, writeJson } = require('./helpers');
const { createFakeFetch, createFakeRunner, jsonResponse, testKeys } = require('./fakes');

const PACKAGE = 'com.example.app';
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;
/* Assemblé à l'exécution : un faux jeton écrit tel quel ressemble à un vrai pour les scanners de secrets. */
const ACCESS_TOKEN = ['ya29', 'do-not-print-me'].join('.');
const KEY_ID = 'ABCDE12345';
const ISSUER = '69a6de7e-1234-47e3-e053-5b8c7c11a4d1';

function setupProject({ version = '1.1.5', published, withAsc = false, withPlayKey = true } = {}) {
  const root = createTempProject();
  const home = createTempProject();
  writeJson(root, 'mobile/package.json', { name: '@acme/mobile', version });
  writeJson(root, 'mobile/app.json', { expo: { runtimeVersion: { policy: 'appVersion' } } });
  writeJson(root, 'mobile/eas.json', {
    build: {
      base: { env: { EXPO_PUBLIC_SENTRY_DSN: 'https://dsn.example' } },
      production: { extends: 'base', env: { EXPO_PUBLIC_API_BASE_URL: 'https://api.acme.example' } }
    }
  });
  writeFile(root, 'mobile/.env', 'EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3000\n');
  if (published) {
    writeFile(root, 'mobile/scripts/.fp', `${published}\n`);
  }
  if (withPlayKey) {
    writeJson(root, 'secrets/play.json', { client_email: 'p@acme.iam.gserviceaccount.com', private_key: testKeys().rsaPem });
  }
  if (withAsc) {
    writeFile(home, '.appstoreconnect/acme.env', `ASC_KEY_ID=${KEY_ID}\nASC_ISSUER_ID=${ISSUER}\n`);
    writeFile(home, `.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`, testKeys().ecPem);
  }
  const config = {
    publish: {
      appName: 'Acme',
      projectDir: 'mobile',
      fingerprintFile: 'scripts/.fp',
      downloadsDir: path.join(root, 'downloads'),
      android: { packageName: PACKAGE, serviceAccountPath: '../secrets/play.json' },
      ios: { ascEnvFile: path.join(home, '.appstoreconnect/acme.env'), keysDirs: [path.join(home, '.appstoreconnect/private_keys')] }
    }
  };
  return { root, home, config };
}

function versionOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'mobile/package.json'), 'utf8')).version;
}

/** The native tree is "N1"; the fingerprint also moves with the version, as Expo's does. */
function fingerprintOf(root, native = 'N1') {
  return async () => `fp-${native}-${versionOf(root)}`;
}

function createWorld({ root, events = [], playFails = null, ascStatus = 200, altoolOutput = 'UPLOAD SUCCEEDED', localFails = false, bundle = 'fetch("https://api.acme.example")' }) {
  const localBuilds = [];
  const exports = [];
  const run = createFakeRunner((command, args, options) => {
    events.push(`${command} ${args.slice(0, 3).join(' ')}`);
    if (command === 'npx' && args[1] === 'build' && args.includes('--local')) {
      const output = args[args.indexOf('--output') + 1];
      localBuilds.push({ args, workDir: options.env && options.env.EAS_LOCAL_BUILD_WORKINGDIR, workDirExisted: Boolean(options.env && options.env.EAS_LOCAL_BUILD_WORKINGDIR && fs.existsSync(options.env.EAS_LOCAL_BUILD_WORKINGDIR)) });
      if (localFails) return { code: 1 };
      fs.writeFileSync(output, `local ${args[3]}`);
      return { stdout: 'Build successful' };
    }
    if (command === 'npx' && args[1] === 'build') {
      return { stdout: JSON.stringify([{ id: `build-${args[3]}` }]) };
    }
    if (command === 'npx' && args[1] === 'build:view') {
      const platform = args[2].replace('build-', '');
      return { stdout: JSON.stringify({ status: 'FINISHED', artifacts: { buildUrl: `https://expo.dev/artifacts/${platform}` }, appBuildVersion: '7' }) };
    }
    if (command === 'npx' && args[0] === 'expo' && args[1] === 'export') {
      const outputDir = args[args.indexOf('--output-dir') + 1];
      exports.push({ args, env: options.env, cwd: options.cwd, outputDir });
      fs.mkdirSync(path.join(outputDir, '_expo/static/js/ios'), { recursive: true });
      fs.writeFileSync(path.join(outputDir, '_expo/static/js/ios/entry.hbc'), bundle);
      return { code: 0 };
    }
    if (command === 'npx' && args[1] === 'update') {
      const inputDir = args[args.indexOf('--input-dir') + 1];
      exports.push({ updateSawBundle: fs.existsSync(path.join(inputDir, '_expo/static/js/ios/entry.hbc')) });
      return { stdout: 'Published update group' };
    }
    if (command === 'git') {
      return { stdout: 'Fix login screen\n' };
    }
    if (command === 'xcrun') {
      return { stdout: altoolOutput };
    }
    return { code: 0 };
  });
  const playStep = (name, ok) => (playFails === name ? jsonResponse(400, { error: { message: 'Version code 7 has already been used.' } }) : ok);
  const fetch = createFakeFetch([
    ['GET https://expo.dev/artifacts/', ({ url }) => { events.push(`download ${url}`); return jsonResponse(200, Buffer.from(`bytes of ${url}`)); }],
    ['POST https://oauth2.googleapis.com/token', jsonResponse(200, { access_token: ACCESS_TOKEN })],
    [`POST ${API}/edits/e1:commit`, () => { events.push('play commit'); return jsonResponse(200, {}); }],
    [`POST ${API}/edits`, () => playStep('edit', jsonResponse(200, { id: 'e1' }))],
    [`POST ${UPLOAD}/edits/e1/bundles`, () => playStep('upload', jsonResponse(200, { versionCode: 7 }))],
    [`PUT ${API}/edits/e1/tracks/internal`, jsonResponse(200, {})],
    [`DELETE ${API}/edits/e1`, jsonResponse(204)],
    ['GET https://api.appstoreconnect.apple.com/v1/apps', () => { events.push('asc check'); return jsonResponse(ascStatus, { data: [{ id: '1' }] }); }]
  ]);
  const notifications = [];
  const opened = [];
  return {
    events,
    localBuilds,
    exports,
    run,
    fetch,
    notifications,
    opened,
    options: {
      runProcess: run,
      fetch,
      sleep: async () => {},
      notify: async (title, message) => notifications.push(`${title}: ${message}`),
      open: async (args) => { opened.push(args); return { code: 0 }; },
      env: {},
      homeDir: root
    }
  };
}

describe('publish orchestrator', () => {
  test('dry run does not inspect credentials, fingerprint, or run publishing commands', async () => {
    const { root, config } = setupProject({ withPlayKey: false });
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'android', dryRun: true, output: createOutput() });
    expect(result).toMatchObject({ exitCode: 0, dryRun: true, target: 'android' });
    expect(world.run.calls).toEqual([]);
    expect(world.fetch.calls).toEqual([]);
    expect(versionOf(root)).toBe('1.1.5');
  });

  test('an existing malformed Apple env file fails before a build, instead of opening Transporter', async () => {
    const { root, home, config } = setupProject();
    writeFile(home, '.appstoreconnect/acme.env', 'ASC_KEY_ID=$(false)\nASC_ISSUER_ID=invalid\n');
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'ios', output: createOutput() });
    expect(result).toMatchObject({ exitCode: 1, error: { code: 'ASC_CREDENTIALS_INVALID' } });
    expect(world.run.calls.some((call) => call.command === 'npx')).toBe(false);
  });

  test('manual store handoff does not mark the native fingerprint as published', async () => {
    const { root, config } = setupProject();
    config.publish.android.upload = 'manual';
    config.publish.versionBump = false;
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'android', computeFingerprint: async () => 'native-one', output: createOutput() });
    expect(result).toMatchObject({ exitCode: 0, results: [{ delivered: false }] });
    expect(fs.existsSync(path.join(root, 'mobile/scripts/.fp'))).toBe(false);
  });

  test('a configured Expo version is reported instead of the package version', async () => {
    const { root, config } = setupProject();
    config.publish.version = '2.4.0';
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'update', message: 'fix', output: createOutput() });
    expect(result).toMatchObject({ exitCode: 0, version: '2.4.0' });
  });
  test('android, first build: bumps the version, builds, downloads, sends to Play, records the fingerprint', async () => {
    const { root, config } = setupProject();
    const world = createWorld({ root });
    const output = createOutput();

    const result = await runPublish(root, config, { ...world.options, target: 'android', output, computeFingerprint: fingerprintOf(root) });

    expect(result.exitCode).toBe(0);
    expect(result.bumped).toMatchObject({ from: '1.1.5', to: '1.1.6' });
    expect(versionOf(root)).toBe('1.1.6');
    expect(result.results[0]).toMatchObject({ platform: 'android', ok: true, delivered: true, versionCode: 7, buildNumber: '7' });
    const file = path.join(root, 'downloads', 'Acme-android-1.1.6-7.aab');
    expect(fs.readFileSync(file, 'utf8')).toBe('bytes of https://expo.dev/artifacts/android');
    // recorded AFTER the bump: the fingerprint of what was really built
    expect(fs.readFileSync(path.join(root, 'mobile/scripts/.fp'), 'utf8')).toBe('fp-N1-1.1.6\n');
    expect(world.run.calls.find((call) => call.args[1] === 'build').args).toEqual(['eas-cli', 'build', '-p', 'android', '--profile', 'production', '--non-interactive', '--no-wait', '--json']);
    expect(world.run.calls.every((call) => call.options.cwd === undefined || call.options.cwd === path.join(root, 'mobile'))).toBe(true);
    expect(world.notifications).toEqual(['android envoye: Version 1.1.6 (7).']);
    const printed = output.lines.join('\n');
    expect(printed).not.toContain(ACCESS_TOKEN);
    expect(printed).not.toContain('PRIVATE KEY');
  });

  test('same native as the last published build: the version stays', async () => {
    const { root, config } = setupProject({ published: 'fp-N1-1.1.5' });
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'android', output: createOutput(), computeFingerprint: fingerprintOf(root) });
    expect(result.exitCode).toBe(0);
    expect(result.bumped).toBeNull();
    expect(versionOf(root)).toBe('1.1.5');
  });

  test('versionBump: false builds without touching package.json', async () => {
    const { root, config } = setupProject({ published: 'old' });
    config.publish.versionBump = false;
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'android', output: createOutput(), computeFingerprint: fingerprintOf(root) });
    expect(result.exitCode).toBe(0);
    expect(versionOf(root)).toBe('1.1.5');
  });

  test('ios with an API key: the key is checked before any build, then altool sends the .ipa', async () => {
    const { root, config } = setupProject({ withAsc: true, published: 'fp-N1-1.1.5' });
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'ios', output: createOutput(), computeFingerprint: fingerprintOf(root) });

    expect(result.exitCode).toBe(0);
    expect(world.events.indexOf('asc check')).toBeLessThan(world.events.findIndex((event) => event.startsWith('npx eas-cli build')));
    const altool = world.run.calls.find((call) => call.command === 'xcrun');
    expect(altool.args).toEqual(['altool', '--upload-app', '-f', path.join(root, 'downloads', 'Acme-ios-1.1.5-7.ipa'), '-t', 'ios', '--apiKey', KEY_ID, '--apiIssuer', ISSUER, '--output-format', 'normal']);
    expect(result.results[0]).toMatchObject({ platform: 'ios', delivered: true });
  });

  test('a rejected Apple key stops everything before a build is spent', async () => {
    const { root, config } = setupProject({ withAsc: true });
    const world = createWorld({ root, ascStatus: 401 });
    const result = await runPublish(root, config, { ...world.options, target: 'ios', output: createOutput(), computeFingerprint: fingerprintOf(root) });
    expect(result.exitCode).toBe(1);
    expect(result.error.code).toBe('ASC_KEY_REJECTED');
    expect(world.run.calls.some((call) => call.args[1] === 'build')).toBe(false);
    expect(versionOf(root)).toBe('1.1.5');
    expect(world.notifications[world.notifications.length - 1]).toMatch(/^echec/);
  });

  test('ios without an API key: Transporter opens with the file, nothing claims it was delivered', async () => {
    const { root, config } = setupProject();
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'ios', output: createOutput(), computeFingerprint: fingerprintOf(root) });
    expect(result.exitCode).toBe(0);
    expect(result.results[0]).toMatchObject({ delivered: false, handoff: 'transporter' });
    expect(world.opened).toEqual([['-a', 'Transporter', path.join(root, 'downloads', 'Acme-ios-1.1.6-7.ipa')]]);
    expect(world.notifications[0]).toMatch(/il reste a livrer/);
  });

  test('ios without key and fallback "none" fails', async () => {
    const { root, config } = setupProject();
    config.publish.ios.fallback = 'none';
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'ios', output: createOutput(), computeFingerprint: fingerprintOf(root) });
    expect(result.exitCode).toBe(1);
    expect(result.results[0]).toMatchObject({ ok: false, code: 'ASC_CREDENTIALS_MISSING' });
  });

  test('all: ios goes out, android fails at Play; stops, reports both, still records the fingerprint', async () => {
    const { root, config } = setupProject({ withAsc: true });
    const world = createWorld({ root, playFails: 'upload' });
    const result = await runPublish(root, config, { ...world.options, target: 'all', output: createOutput(), computeFingerprint: fingerprintOf(root) });
    expect(result.exitCode).toBe(1);
    expect(result.results.map((entry) => [entry.platform, entry.ok])).toEqual([['ios', true], ['android', false]]);
    expect(result.results[1].code).toBe('PLAY_UPLOAD_FAILED');
    expect(fs.readFileSync(path.join(root, 'mobile/scripts/.fp'), 'utf8')).toBe('fp-N1-1.1.6\n');
  });

  test('nothing went out: the fingerprint is not recorded, so the next run still sees the change', async () => {
    const { root, config } = setupProject();
    const world = createWorld({ root, playFails: 'edit' });
    const result = await runPublish(root, config, { ...world.options, target: 'android', output: createOutput(), computeFingerprint: fingerprintOf(root) });
    expect(result.exitCode).toBe(1);
    expect(fs.existsSync(path.join(root, 'mobile/scripts/.fp'))).toBe(false);
  });

  test('android without a readable service-account key fails before building', async () => {
    const { root, config } = setupProject({ withPlayKey: false });
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'android', output: createOutput(), computeFingerprint: fingerprintOf(root) });
    expect(result.error.code).toBe('PLAY_KEY_MISSING');
    expect(world.run.calls).toHaveLength(0);
  });

  test('android in manual mode opens the Play Console instead of the API', async () => {
    const { root, config } = setupProject({ withPlayKey: false });
    config.publish.android.upload = 'manual';
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'android', output: createOutput(), computeFingerprint: fingerprintOf(root) });
    expect(result.exitCode).toBe(0);
    expect(world.opened).toEqual([['https://play.google.com/console']]);
    expect(world.fetch.calls.some((call) => call.url.includes('androidpublisher'))).toBe(false);
  });

  test('update: the bundle is made here with the build profile, sent with its environment, then removed', async () => {
    const { root, config } = setupProject();
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'update', output: createOutput() });
    expect(result).toMatchObject({ exitCode: 0, version: '1.1.5', message: 'Fix login screen' });
    const [made, sent] = world.exports;
    expect(made.args).toEqual(['expo', 'export', '--platform', 'ios', '--platform', 'android', '--output-dir', made.outputDir]);
    expect(made.cwd).toBe(path.join(root, 'mobile'));
    // Le profil (et ce dont il herite) recouvre le .env local.
    expect(made.env).toMatchObject({ EXPO_PUBLIC_API_BASE_URL: 'https://api.acme.example', EXPO_PUBLIC_SENTRY_DSN: 'https://dsn.example' });
    expect(sent.updateSawBundle).toBe(true);
    expect(world.run.calls.find((call) => call.args[1] === 'update').args).toEqual([
      'eas-cli', 'update', '--channel', 'production', '--environment', 'production', '--message', 'Fix login screen',
      '--skip-bundler', '--input-dir', made.outputDir, '--non-interactive'
    ]);
    expect(fs.existsSync(made.outputDir)).toBe(false);
    expect(versionOf(root)).toBe('1.1.5');
  });

  test('update keeps an explicit message word for word', async () => {
    const { root, config } = setupProject();
    const world = createWorld({ root });
    await runPublish(root, config, { ...world.options, target: 'update', message: 'Depuis l\'iPhone; $(date)', output: createOutput() });
    const args = world.run.calls.find((call) => call.args[1] === 'update').args;
    expect(args[args.indexOf('--message') + 1]).toBe('Depuis l\'iPhone; $(date)');
  });

  test('update refused before anything is made when the app would point to this machine', async () => {
    const { root, config } = setupProject();
    writeJson(root, 'mobile/eas.json', { build: { production: { env: {} } } });
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'update', message: 'fix', output: createOutput() });
    expect(result).toMatchObject({ exitCode: 1, error: { code: 'EAS_UPDATE_LOCAL_URL' } });
    expect(world.exports).toEqual([]);
    expect(world.run.calls.some((call) => call.args[1] === 'update')).toBe(false);
  });

  test('update refused when the made bundle still holds the local address', async () => {
    const { root, config } = setupProject();
    const world = createWorld({ root, bundle: 'fetch("http://127.0.0.1:3000")' });
    const result = await runPublish(root, config, { ...world.options, target: 'update', message: 'fix', output: createOutput() });
    expect(result).toMatchObject({ exitCode: 1, error: { code: 'EAS_UPDATE_LOCAL_URL_IN_BUNDLE' } });
    expect(world.run.calls.some((call) => call.args[1] === 'update')).toBe(false);
    expect(fs.existsSync(world.exports[0].outputDir)).toBe(false);
  });

  test('update refused when the build profile is missing from eas.json', async () => {
    const { root, config } = setupProject();
    config.publish.eas = { profile: 'staging' };
    const world = createWorld({ root });
    const result = await runPublish(root, config, { ...world.options, target: 'update', message: 'fix', output: createOutput() });
    expect(result).toMatchObject({ exitCode: 1, error: { code: 'EAS_PROFILE_MISSING' } });
    expect(world.exports).toEqual([]);
  });

  test('an unknown target is refused with the usage', async () => {
    await expect(runPublish('/tmp', {}, { target: 'tout' })).rejects.toMatchObject({ code: 'PUBLISH_TARGET_INVALID' });
  });
});

describe('publish, local build', () => {
  const localConfig = (config, root, extra = {}) => ({
    publish: { ...config.publish, eas: { mode: 'local', localWorkDir: path.join(root, 'chantier'), ...extra } }
  });

  test('android: builds on this machine into the downloads folder, sends to Play, cleans the work folder', async () => {
    const { root, config } = setupProject();
    const world = createWorld({ root });
    const now = () => Date.parse('2026-10-01T18:42:00Z');

    const result = await runPublish(root, localConfig(config, root), { ...world.options, target: 'android', output: createOutput(), now, computeFingerprint: fingerprintOf(root) });

    expect(result.exitCode).toBe(0);
    expect(result.results[0]).toMatchObject({ platform: 'android', ok: true, delivered: true, versionCode: 7 });
    const file = path.join(root, 'downloads', 'Acme-android-1.1.6-local-20261001-1842.aab');
    expect(fs.readFileSync(file, 'utf8')).toBe('local android');
    expect(fs.readdirSync(path.join(root, 'downloads'))).toEqual(['Acme-android-1.1.6-local-20261001-1842.aab']);
    const [build] = world.localBuilds;
    expect(build.args).toEqual(['eas-cli', 'build', '-p', 'android', '--profile', 'production', '--local', '--non-interactive', '--output', `${file}.part.aab`]);
    expect(build.workDir).toBe(path.join(root, 'chantier', 'travail-android'));
    expect(build.workDirExisted).toBe(true);
    expect(fs.existsSync(build.workDir)).toBe(false);
    expect(world.run.calls.some((call) => call.args[1] === 'build:view')).toBe(false);
    expect(world.events.some((event) => event.startsWith('download'))).toBe(false);
  });

  test('a failed local build sends nothing, leaves no partial file and does not record the fingerprint', async () => {
    const { root, config } = setupProject({ published: 'fp-N0-1.1.5' });
    const world = createWorld({ root, localFails: true });

    const result = await runPublish(root, localConfig(config, root), { ...world.options, target: 'android', output: createOutput(), computeFingerprint: fingerprintOf(root) });

    expect(result.exitCode).toBe(1);
    expect(result.error.code).toBe('EAS_LOCAL_BUILD_FAILED');
    expect(fs.existsSync(path.join(root, 'downloads')) ? fs.readdirSync(path.join(root, 'downloads')) : []).toEqual([]);
    expect(world.events.some((event) => event.startsWith('play'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'mobile/scripts/.fp'), 'utf8')).toBe('fp-N0-1.1.5\n');
    expect(fs.existsSync(path.join(root, 'chantier', 'travail-android'))).toBe(false);
  });

  test('an unknown build mode stops before any version bump or build', async () => {
    const { root, config } = setupProject();
    const world = createWorld({ root });

    const result = await runPublish(root, localConfig(config, root, { mode: 'cloudd' }), { ...world.options, target: 'android', output: createOutput(), computeFingerprint: fingerprintOf(root) });

    expect(result.exitCode).toBe(1);
    expect(versionOf(root)).toBe('1.1.5');
    expect(world.run.calls.some((call) => call.args[1] === 'build')).toBe(false);
  });
});

describe('publish sub-commands', () => {
  test('publish:fingerprint compares, and records only with --record', async () => {
    const { root, config } = setupProject({ published: 'old' });
    const output = createOutput();
    const compared = await runPublishFingerprint(root, config, { output, computeFingerprint: fingerprintOf(root) });
    expect(compared).toMatchObject({ exitCode: 0, current: 'fp-N1-1.1.5', published: 'old', decision: { bump: true, reason: 'native-changed' }, recorded: false });
    expect(fs.readFileSync(path.join(root, 'mobile/scripts/.fp'), 'utf8')).toBe('old\n');
    await runPublishFingerprint(root, config, { output, record: true, computeFingerprint: fingerprintOf(root) });
    expect(fs.readFileSync(path.join(root, 'mobile/scripts/.fp'), 'utf8')).toBe('fp-N1-1.1.5\n');
  });

  test('publish:upload sends an existing .aab without building', async () => {
    const { root, config } = setupProject();
    writeFile(root, 'out/app.aab', 'aab');
    const world = createWorld({ root });
    const result = await runPublishUpload(root, config, { ...world.options, platform: 'android', file: 'out/app.aab', output: createOutput() });
    expect(result).toMatchObject({ exitCode: 0, delivered: true, versionCode: 7 });
    expect(world.run.calls).toHaveLength(0);
    const missing = await runPublishUpload(root, config, { ...world.options, platform: 'android', file: 'out/none.aab', output: createOutput() });
    expect(missing.error.code).toBe('PUBLISH_FILE_MISSING');
  });

  test('publish:check-ios reports the key state', async () => {
    const { root, config } = setupProject({ withAsc: true });
    const world = createWorld({ root, ascStatus: 403 });
    const result = await runPublishCheckIos(root, config, { ...world.options, output: createOutput() });
    expect(result).toMatchObject({ exitCode: 1, error: { code: 'ASC_KEY_FORBIDDEN' } });
  });

  test('the CLI takes a bare target word: `astratra publish update --message=...`', async () => {
    const { root, config } = setupProject();
    const events = [];
    const world = createWorld({ root, events });
    // The CLI passes its parsed args as options; the doubles are merged in through the config-free path.
    const originalLog = console.log;
    console.log = () => {};
    try {
      const { COMMANDS } = require('../src/cli');
      const original = COMMANDS.publish;
      COMMANDS.publish = (rootDir, cfg, args) => original(rootDir, cfg, { ...world.options, ...args });
      try {
        const result = await runCli(['publish', 'update', '--message=hello'], { rootDir: root, config });
        expect(result).toMatchObject({ exitCode: 0, target: 'update', message: 'hello' });
      } finally {
        COMMANDS.publish = original;
      }
    } finally {
      console.log = originalLog;
      process.exitCode = 0;
    }
  });
});
