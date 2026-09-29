/* global fetch */
const fs = require('fs');
const os = require('os');
const path = require('path');
const colors = require('../colors');
const { mergeConfig } = require('../config');
const { ToolingError } = require('../errors');
const { runProcess } = require('../processRunner');
const {
  computeFingerprint,
  decideVersionBump,
  readPublishedFingerprint,
  readRuntimeVersionPolicy,
  recordPublishedFingerprint
} = require('../publish/fingerprint');
const { applyVersionBump, readPackageVersion } = require('../publish/version');
const {
  archiveExtension,
  artifactFileName,
  buildEasBuildArgs,
  buildEasUpdateArgs,
  buildEasViewArgs,
  downloadArtifact,
  formatBytes,
  parseBuildStart,
  parseBuildView,
  waitForBuild
} = require('../publish/eas');
const { createGooglePlayClient, loadServiceAccount } = require('../publish/googlePlay');
const { checkAscKey, expandHome, hasAscCredentials, loadAscCredentials, uploadToAppStore } = require('../publish/appStoreConnect');
const { createDesktopNotifier } = require('../publish/notify');

const PUBLISH_DEFAULTS = {
  appName: null,
  version: null,
  projectDir: '.',
  fingerprintFile: '.native-fingerprint-published',
  fingerprint: { command: null },
  versionBump: 'patch',
  eas: {
    command: ['npx', 'eas-cli'],
    profile: 'production',
    channel: 'production',
    pollIntervalMs: 60000,
    timeoutMs: 3 * 60 * 60 * 1000,
    maxViewFailures: 5,
    buildUrlTemplate: null
  },
  downloadsDir: '~/Downloads',
  fileNameTemplate: null,
  android: {
    upload: 'api',
    packageName: null,
    track: 'internal',
    releaseStatus: 'completed',
    serviceAccountPath: null,
    serviceAccountJsonEnv: null,
    consoleUrl: 'https://play.google.com/console'
  },
  ios: {
    ascEnvFile: null,
    keyIdEnv: 'ASC_KEY_ID',
    issuerIdEnv: 'ASC_ISSUER_ID',
    privateKeyPath: null,
    keysDirs: null,
    bundleId: null,
    checkKey: true,
    fallback: 'transporter'
  },
  notify: true
};

const TARGETS = {
  ios: ['ios'],
  android: ['android'],
  all: ['ios', 'android'],
  update: []
};

function resolvePublishConfig(rootDir, config = {}, homeDir = os.homedir()) {
  const merged = mergeConfig(PUBLISH_DEFAULTS, config.publish || {});
  const projectDir = path.resolve(rootDir, merged.projectDir || '.');
  const resolveIn = (base, value) => (value ? path.resolve(base, expandHome(value, homeDir)) : value);

  return {
    ...merged,
    projectDir,
    fingerprintFile: resolveIn(projectDir, merged.fingerprintFile),
    downloadsDir: resolveIn(projectDir, merged.downloadsDir),
    android: {
      ...merged.android,
      serviceAccountPath: resolveIn(projectDir, merged.android.serviceAccountPath)
    },
    ios: {
      ...merged.ios,
      ascEnvFile: resolveIn(projectDir, merged.ios.ascEnvFile),
      privateKeyPath: resolveIn(projectDir, merged.ios.privateKeyPath),
      keysDirs: Array.isArray(merged.ios.keysDirs) ? merged.ios.keysDirs.map((dir) => resolveIn(projectDir, dir)) : null
    }
  };
}

function resolveAppName(publishConfig) {
  if (publishConfig.appName) {
    return publishConfig.appName;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(publishConfig.projectDir, 'package.json'), 'utf8'));
    return String(pkg.name || 'app').replace(/^@[^/]+\//, '');
  } catch (_error) {
    return 'app';
  }
}

function createContext(rootDir, config, options) {
  const homeDir = options.homeDir || os.homedir();
  const publishConfig = resolvePublishConfig(rootDir, config, homeDir);
  const run = options.runProcess || runProcess;
  const output = options.output || console;
  const platform = options.osPlatform || process.platform;
  const env = options.env || process.env;

  return {
    publishConfig,
    run,
    output,
    env,
    homeDir,
    fetch: options.fetch || (typeof fetch === 'function' ? fetch : null),
    sleep: options.sleep,
    now: options.now,
    notify: options.notify || createDesktopNotifier({
      enabled: publishConfig.notify !== false,
      runProcess: run,
      platform,
      titlePrefix: resolveAppName(publishConfig)
    }),
    open: options.open || (async (args) => {
      if (platform !== 'darwin') {
        output.log(colors.yellow(`A ouvrir a la main : ${args[args.length - 1]}`));
        return { code: 0 };
      }
      return run('open', args, { quiet: true });
    }),
    computeFingerprintFn: options.computeFingerprint
  };
}

function ascOptions(ctx) {
  const ios = ctx.publishConfig.ios;
  return {
    envFile: ios.ascEnvFile,
    keyIdEnv: ios.keyIdEnv,
    issuerIdEnv: ios.issuerIdEnv,
    privateKeyPath: ios.privateKeyPath,
    keysDirs: ios.keysDirs,
    env: ctx.env,
    homeDir: ctx.homeDir,
    cwd: ctx.publishConfig.projectDir
  };
}

function ascCredentialsAvailable(ctx) {
  const options = ascOptions(ctx);
  // Un fichier explicitement present mais invalide est une erreur de configuration.
  if (options.envFile && fs.existsSync(options.envFile)) {
    loadAscCredentials(options);
    return true;
  }
  return hasAscCredentials(options);
}

async function runEas(ctx, args, { quietStdout = true } = {}) {
  const [command, ...prefix] = ctx.publishConfig.eas.command;
  return ctx.run(command, [...prefix, ...args], {
    cwd: ctx.publishConfig.projectDir,
    quietStdout,
    onLine: (line) => ctx.output.log(colors.dim(`  ${line}`))
  });
}

async function currentFingerprint(ctx) {
  return computeFingerprint(ctx.publishConfig.projectDir, {
    compute: ctx.computeFingerprintFn,
    command: ctx.publishConfig.fingerprint && ctx.publishConfig.fingerprint.command,
    runProcess: ctx.run
  });
}

/** Compare the tree with the last published build, bump the version when the native side moved. */
async function prepareVersion(ctx) {
  const { publishConfig, output } = ctx;
  let current = await currentFingerprint(ctx);
  const published = readPublishedFingerprint(publishConfig.fingerprintFile);
  const decision = decideVersionBump({ current, published });
  let bumped = null;

  const policy = readRuntimeVersionPolicy(publishConfig.projectDir);
  if (policy !== 'appVersion' && policy !== 'unknown') {
    output.log(colors.yellow(`runtimeVersion n'est pas { policy: "appVersion" } (${policy}) : la montee de version ne protege pas les mises a jour a distance.`));
  }

  if (decision.bump && publishConfig.versionBump) {
    bumped = applyVersionBump(publishConfig.projectDir, publishConfig.versionBump);
    output.log(`Natif change depuis le dernier build publie (${decision.reason}) : version ${bumped.from} -> ${bumped.to}.`);
    // The version is part of the native config: the fingerprint of what is really built changes with it.
    current = await currentFingerprint(ctx);
  } else if (decision.bump) {
    output.log(colors.yellow('Natif change, montee de version desactivee (publish.versionBump = false).'));
  } else {
    output.log('Natif inchange depuis le dernier build publie : la version reste.');
  }

  return { fingerprint: current, decision, bumped, version: publishConfig.version || readPackageVersion(publishConfig.projectDir) };
}

async function buildOnEas(ctx, platformName, version) {
  const { publishConfig, output } = ctx;
  output.log(colors.bold(`Fabrication ${platformName}, version ${version}, chez Expo...`));
  const started = await runEas(ctx, buildEasBuildArgs({ platform: platformName, profile: publishConfig.eas.profile }));
  if (started.code !== 0) {
    throw new ToolingError('EAS_BUILD_START_FAILED', `eas build ${platformName} a echoue (code ${started.code}).`, 502);
  }
  const buildId = parseBuildStart(started.stdout);
  const link = publishConfig.eas.buildUrlTemplate ? ` : ${publishConfig.eas.buildUrlTemplate.replace('{buildId}', buildId)}` : '';
  output.log(`Build ${buildId} en file${link}.`);

  const state = await waitForBuild({
    buildId,
    intervalMs: publishConfig.eas.pollIntervalMs,
    timeoutMs: publishConfig.eas.timeoutMs,
    maxViewFailures: publishConfig.eas.maxViewFailures,
    sleep: ctx.sleep,
    now: ctx.now,
    view: async (id) => {
      const viewed = await runEas(ctx, buildEasViewArgs(id));
      if (viewed.code !== 0) {
        throw new ToolingError('EAS_BUILD_VIEW_FAILED', `eas build:view a echoue (code ${viewed.code}).`, 502);
      }
      return parseBuildView(viewed.stdout);
    },
    onStatus: (viewedState) => output.log(`${new Date(ctx.now ? ctx.now() : Date.now()).toISOString().slice(11, 16)} ${platformName} ${viewedState.status}`)
  });

  const fileName = artifactFileName({
    appName: resolveAppName(publishConfig),
    platform: platformName,
    version,
    buildNumber: state.buildNumber,
    template: publishConfig.fileNameTemplate
  });
  const downloaded = await downloadArtifact({ url: state.url, filePath: path.join(publishConfig.downloadsDir, fileName), fetch: ctx.fetch });
  output.log(`Telecharge : ${downloaded.filePath} (${formatBytes(downloaded.bytes)})`);
  return { buildId, buildNumber: state.buildNumber, filePath: downloaded.filePath };
}

async function sendToGooglePlay(ctx, filePath) {
  const android = ctx.publishConfig.android;

  if (android.upload === 'manual') {
    await ctx.open([android.consoleUrl]);
    ctx.output.log(`Play Console ouverte : nouvelle version sur la piste ${android.track}, deposer ${path.basename(filePath)}.`);
    return { delivered: false, handoff: 'play-console' };
  }

  const serviceAccount = loadServiceAccount({
    path: android.serviceAccountPath,
    jsonEnv: android.serviceAccountJsonEnv,
    env: ctx.env
  });
  const client = createGooglePlayClient({ packageName: android.packageName, serviceAccount, fetch: ctx.fetch, now: ctx.now });
  const sent = await client.uploadBundle({ filePath, track: android.track, releaseStatus: android.releaseStatus });
  ctx.output.log(colors.green(`Envoye a Google Play : ${sent.packageName}, piste ${sent.track}, code de version ${sent.versionCode}.`));
  return { delivered: true, versionCode: sent.versionCode };
}

async function sendToAppStore(ctx, filePath) {
  const ios = ctx.publishConfig.ios;

  if (!ascCredentialsAvailable(ctx)) {
    if (ios.fallback === 'transporter') {
      await ctx.open(['-a', 'Transporter', filePath]);
      ctx.output.log(colors.yellow('Cle d\'API Apple absente : Transporter est ouvert avec le fichier, il reste « Livrer ».'));
      return { delivered: false, handoff: 'transporter' };
    }
    throw new ToolingError('ASC_CREDENTIALS_MISSING', 'Cle d\'API Apple absente et aucun repli configure.', 400);
  }

  const credentials = loadAscCredentials(ascOptions(ctx));
  await uploadToAppStore({
    filePath,
    credentials,
    runProcess: ctx.run,
    env: ctx.env,
    onLine: (line) => ctx.output.log(colors.dim(`  ${line}`))
  });
  ctx.output.log(colors.green('Envoye a App Store Connect : Apple le traite, puis il parait dans TestFlight.'));
  return { delivered: true };
}

async function verifyIosKey(ctx) {
  const ios = ctx.publishConfig.ios;
  if (!ios.checkKey || !ascCredentialsAvailable(ctx)) {
    return null;
  }
  const credentials = loadAscCredentials(ascOptions(ctx));
  const checked = await checkAscKey({ credentials, fetch: ctx.fetch, now: ctx.now, bundleId: ios.bundleId });
  ctx.output.log('Cle App Store Connect valide.');
  return checked;
}

async function lastCommitSubject(ctx) {
  const result = await ctx.run('git', ['log', '-1', '--format=%s'], { cwd: ctx.publishConfig.projectDir, quiet: true });
  return result.code === 0 ? result.stdout.trim() : '';
}

async function runUpdate(ctx, message) {
  const version = ctx.publishConfig.version || readPackageVersion(ctx.publishConfig.projectDir);
  const finalMessage = message || await lastCommitSubject(ctx);
  const result = await runEas(ctx, buildEasUpdateArgs({ channel: ctx.publishConfig.eas.channel, message: finalMessage }), { quietStdout: false });
  if (result.code !== 0) {
    throw new ToolingError('EAS_UPDATE_FAILED', `eas update a echoue (code ${result.code}).`, 502);
  }
  ctx.output.log(colors.green(`Envoye : les applications en version ${version} la prennent a leur prochain lancement.`));
  await ctx.notify('mise a jour envoyee', `Version ${version} : ${finalMessage}`);
  return { exitCode: 0, target: 'update', version, message: finalMessage, results: [] };
}

/**
 * ios | android | all | update, with no question asked:
 * - update: JavaScript only, straight to installed apps of the same version;
 * - builds: version bumped when the native fingerprint moved, Apple key
 *   checked before any build, each platform built on EAS, downloaded, sent.
 * Stops at the first failing platform; the fingerprint is recorded once at
 * least one platform went through, so the next run does not bump again for
 * a native tree that is already out.
 */
async function runPublish(rootDir, config, options = {}) {
  const target = options.target || options.platform || options._target;
  if (!Object.prototype.hasOwnProperty.call(TARGETS, target || '')) {
    throw new ToolingError('PUBLISH_TARGET_INVALID', 'Usage : astratra publish ios|android|all|update [--message="..."] (ou --target=...)', 400);
  }

  const ctx = createContext(rootDir, config, options);
  ctx.output.log(`${colors.blue(`Publication (${target})`)}\n`);

  if (options['dry-run'] || options.dryRun) {
    ctx.output.log(`Essai a blanc : projet ${ctx.publishConfig.projectDir} ; cible ${target} ; profil ${ctx.publishConfig.eas.profile} ; canal ${ctx.publishConfig.eas.channel} ; envoi Android ${ctx.publishConfig.android.upload} ; repli iOS ${ctx.publishConfig.ios.fallback}.`);
    return { exitCode: 0, dryRun: true, target, results: [] };
  }

  try {
    if (target === 'update') {
      return await runUpdate(ctx, typeof options.message === 'string' ? options.message : '');
    }

    const platforms = TARGETS[target];
    if (platforms.includes('android') && ctx.publishConfig.android.upload === 'api') {
      // Fails before a build is spent: the key must at least be readable.
      loadServiceAccount({ path: ctx.publishConfig.android.serviceAccountPath, jsonEnv: ctx.publishConfig.android.serviceAccountJsonEnv, env: ctx.env });
    }
    if (platforms.includes('ios')) {
      await verifyIosKey(ctx);
    }

    const prepared = await prepareVersion(ctx);
    const results = [];
    let failure = null;

    for (const platformName of platforms) {
      try {
        const built = await buildOnEas(ctx, platformName, prepared.version);
        const sent = platformName === 'android' ? await sendToGooglePlay(ctx, built.filePath) : await sendToAppStore(ctx, built.filePath);
        results.push({ platform: platformName, ok: true, ...built, ...sent });
        await ctx.notify(
          sent.delivered ? `${platformName} envoye` : `${platformName} pret`,
          `Version ${prepared.version} (${built.buildNumber || '?'})${sent.delivered ? '' : ' : il reste a livrer a la main'}.`
        );
      } catch (error) {
        results.push({ platform: platformName, ok: false, code: error.code || 'PUBLISH_FAILED', message: error.message });
        failure = error;
        break;
      }
    }

    if (results.some((entry) => entry.ok && entry.delivered)) {
      recordPublishedFingerprint(ctx.publishConfig.fingerprintFile, prepared.fingerprint);
    }

    if (failure) {
      ctx.output.log(colors.red(`Publication arretee : ${failure.message}`));
      await ctx.notify('echec', 'La publication s\'est arretee : voir le terminal.');
      return { exitCode: 1, target, version: prepared.version, bumped: prepared.bumped, results, error: { code: failure.code, message: failure.message } };
    }

    ctx.output.log(colors.green(`Termine : version ${prepared.version}.`));
    return { exitCode: 0, target, version: prepared.version, bumped: prepared.bumped, results };
  } catch (error) {
    ctx.output.log(colors.red(`Publication impossible : ${error.message}`));
    await ctx.notify('echec', 'La publication s\'est arretee : voir le terminal.');
    return { exitCode: 1, target, results: [], error: { code: error.code || 'PUBLISH_FAILED', message: error.message } };
  }
}

/** `astratra publish:fingerprint [--record]` : compare (and optionally record) without building. */
async function runPublishFingerprint(rootDir, config, options = {}) {
  const ctx = createContext(rootDir, config, options);
  try {
    const current = await currentFingerprint(ctx);
    const published = readPublishedFingerprint(ctx.publishConfig.fingerprintFile);
    const decision = decideVersionBump({ current, published });
    ctx.output.log(`Empreinte actuelle : ${current}`);
    ctx.output.log(`Derniere publiee   : ${published || '(aucune)'}`);
    ctx.output.log(decision.bump ? colors.yellow(`Le prochain build montera la version (${decision.reason}).`) : colors.green('Natif inchange : pas de montee de version.'));
    if (options.record) {
      recordPublishedFingerprint(ctx.publishConfig.fingerprintFile, current);
      ctx.output.log(`Enregistree dans ${ctx.publishConfig.fingerprintFile}.`);
    }
    return { exitCode: 0, current, published, decision, recorded: Boolean(options.record) };
  } catch (error) {
    ctx.output.log(colors.red(error.message));
    return { exitCode: 1, error: { code: error.code, message: error.message } };
  }
}

/** `astratra publish:upload --platform=ios|android --file=<archive>` : send an archive already built. */
async function runPublishUpload(rootDir, config, options = {}) {
  const ctx = createContext(rootDir, config, options);
  try {
    const platformName = options.platform;
    archiveExtension(platformName);
    const filePath = path.resolve(rootDir, String(options.file || ''));
    if (!options.file || !fs.existsSync(filePath)) {
      throw new ToolingError('PUBLISH_FILE_MISSING', `Fichier introuvable : ${options.file || '(aucun)'}`, 400);
    }
    const sent = platformName === 'android' ? await sendToGooglePlay(ctx, filePath) : await sendToAppStore(ctx, filePath);
    return { exitCode: 0, platform: platformName, ...sent };
  } catch (error) {
    ctx.output.log(colors.red(error.message));
    return { exitCode: 1, error: { code: error.code, message: error.message } };
  }
}

/** `astratra publish:check-ios` : one signed call to App Store Connect, nothing built. */
async function runPublishCheckIos(rootDir, config, options = {}) {
  const ctx = createContext(rootDir, config, options);
  try {
    const credentials = loadAscCredentials(ascOptions(ctx));
    const checked = await checkAscKey({ credentials, fetch: ctx.fetch, now: ctx.now, bundleId: ctx.publishConfig.ios.bundleId });
    ctx.output.log(colors.green(`Cle App Store Connect valide (${checked.appCount} app visible).`));
    return { exitCode: 0, ...checked };
  } catch (error) {
    ctx.output.log(colors.red(error.message));
    return { exitCode: 1, error: { code: error.code, message: error.message } };
  }
}

module.exports = {
  PUBLISH_DEFAULTS,
  PUBLISH_TARGETS: Object.keys(TARGETS),
  resolvePublishConfig,
  runPublish,
  runPublishCheckIos,
  runPublishFingerprint,
  runPublishUpload
};
