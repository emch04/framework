const fs = require('fs');
const path = require('path');
const { runPublish } = require('../src/commands/publish');
const { mergeConfig } = require('../src/config');
const { windowsCommand } = require('../src/processRunner');
const { electronBuilderConfig, fileSlug, resolveDesktopConfig, signingEnv } = require('../src/publish/desktop');
const { createOutput, createTempProject, writeFile, writeJson } = require('./helpers');
const { createFakeRunner } = require('./fakes');

/* A workspace like Examen d'État: the Electron app in desktop/, its icons in desktop/build. */
function setupProject({ desktop = {}, version = '1.0.0', scripts = { build: 'vite build' } } = {}) {
  const root = createTempProject();
  writeJson(root, 'desktop/package.json', { name: '@acme/desktop', version, main: 'electron/main.js', scripts });
  writeFile(root, 'desktop/electron/main.js', '');
  writeFile(root, 'desktop/build/icon.ico', 'ico');
  writeFile(root, 'desktop/build/icon.icns', 'icns');
  const config = { publish: { desktop: { appDir: 'desktop', appId: 'com.acme.bureau', productName: 'Acmé Bureau', ...desktop } } };
  return { root, config };
}

const versionOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8')).version;

/** electron-builder that writes the installers it was asked for into the output folder. */
function fakeBuilder(root, { fails = [] } = {}) {
  return createFakeRunner(async (command, args) => {
    if (command === 'npm') return { code: 0 };
    const platform = args.includes('--win') ? 'windows' : 'mac';
    if (fails.includes(platform)) return { code: 1, stderr: 'boom' };
    const config = JSON.parse(fs.readFileSync(args.find((a) => a.startsWith('--config=')).slice('--config='.length), 'utf8'));
    const out = config.directories.output;
    const v = versionOf(root);
    if (platform === 'windows') writeFile(out, `acme-bureau-${v}-setup-x64.exe`, 'exe');
    else writeFile(out, `acme-bureau-${v}-mac-arm64.dmg`, 'dmg');
    return { code: 0 };
  });
}

const options = (root, extra = {}) => ({
  output: createOutput(), notify: async () => {}, env: {}, homeDir: root, osPlatform: 'darwin',
  electronBuilderInstalled: () => true, ...extra
});

describe('publish.desktop configuration', () => {
  test('a complete section is accepted, with its defaults', () => {
    const { root, config } = setupProject();
    const desktop = resolveDesktopConfig(root, config.publish.desktop, mergeConfig);
    expect(desktop.appDir).toBe(path.join(root, 'desktop'));
    expect(desktop.platforms).toEqual(['windows', 'mac']);
    expect(desktop.targets).toEqual({ windows: ['nsis'], mac: ['dmg', 'zip'] });
    expect(desktop.outputDir).toBe(path.join(root, 'desktop', 'release'));
    expect(desktop.icons.windows).toBe(path.join(root, 'desktop', 'build', 'icon.ico'));
  });

  test.each([
    [{ appDir: undefined }, /appDir manquant/],
    [{ appDir: 'nowhere' }, /appDir introuvable/],
    [{ appId: 'bureau' }, /appId manquant ou mal forme/],
    [{ icons: { windows: 'build/absent.ico' } }, /icone windows introuvable/],
    [{ targets: { windows: ['appx'] } }, /targets.windows : appx inconnu/],
    [{ platforms: ['linux'] }, /platforms : linux inconnu/],
    [{ signing: { windows: 'maybe' } }, /signing.windows/],
    [{ buildScript: 'compile' }, /le script npm "compile" n'existe pas/],
    [{ outputDir: '.' }, /outputDir ne peut pas etre/]
  ])('refuses %j with a clear message', (override, message) => {
    const { root, config } = setupProject({ desktop: override });
    const section = { ...config.publish.desktop, ...override };
    if (override.appDir === undefined && 'appDir' in override) delete section.appDir;
    expect(() => resolveDesktopConfig(root, section, mergeConfig)).toThrow(message);
  });

  test('an app without "main" or without the section is refused', () => {
    const { root, config } = setupProject();
    writeJson(root, 'desktop/package.json', { name: 'x', version: '1.0.0', scripts: { build: 'b' } });
    expect(() => resolveDesktopConfig(root, config.publish.desktop, mergeConfig)).toThrow(/n'a pas de "main"/);
    expect(() => resolveDesktopConfig(root, null, mergeConfig)).toThrow(/section absente/);
  });

  test('the installed Electron version is given to electron-builder, which refuses a range in package.json', () => {
    const { root, config } = setupProject();
    writeJson(root, 'node_modules/electron/package.json', { name: 'electron', version: '44.5.1' });
    const desktop = resolveDesktopConfig(root, config.publish.desktop, mergeConfig);
    expect(desktop.electronVersion).toBe('44.5.1');
    expect(electronBuilderConfig(desktop, mergeConfig).electronVersion).toBe('44.5.1');
    const pinned = electronBuilderConfig({ ...desktop, electronBuilder: { electronVersion: '44.0.0' } }, mergeConfig);
    expect(pinned.electronVersion).toBe('44.0.0');
  });

  test('the generated electron-builder configuration: NSIS per user, plain file names, never published', () => {
    const { root, config } = setupProject({ desktop: { electronBuilder: { mac: { category: 'public.app-category.education' } } } });
    const built = electronBuilderConfig(resolveDesktopConfig(root, config.publish.desktop, mergeConfig), mergeConfig);
    expect(built.appId).toBe('com.acme.bureau');
    expect(built.productName).toBe('Acmé Bureau');
    expect(built.publish).toBeNull();
    expect(built.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
    expect(built.nsis).toMatchObject({ oneClick: false, perMachine: false, artifactName: 'acme-bureau-${version}-setup-${arch}.${ext}' });
    expect(built.mac).toMatchObject({ category: 'public.app-category.education', target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }] });
    expect(fileSlug('Examen d\'État — Bureau')).toBe('examen-d-etat-bureau');
  });
});

describe('signing', () => {
  const where = (root) => ({ projectDir: root, homeDir: root });

  test('off removes every certificate and the keychain discovery', () => {
    const { env, signed } = signingEnv('mac', 'off', { CSC_LINK: '/secure/a.p12', CSC_NAME: 'Dev', KEEP: '1' }, where('/srv/app'));
    expect(env).toEqual({ KEEP: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
    expect(signed).toBe(false);
  });

  test('required refuses without a certificate in the environment; auto builds unsigned and says so', () => {
    expect(() => signingEnv('windows', 'required', {}, where('/srv/app'))).toThrow(/WIN_CSC_LINK/);
    expect(signingEnv('windows', 'auto', {}, where('/srv/app')).note).toMatch(/SmartScreen/);
    expect(signingEnv('windows', 'required', { WIN_CSC_LINK: '/secure/w.pfx' }, where('/srv/app')).signed).toBe(true);
  });

  test('a certificate inside the project is refused: it would end up in a repository', () => {
    expect(() => signingEnv('windows', 'auto', { WIN_CSC_LINK: '/srv/app/certs/w.pfx' }, where('/srv/app'))).toThrow(/dans le projet/);
    expect(signingEnv('windows', 'auto', { WIN_CSC_LINK: 'https://vault.example/w.pfx' }, where('/srv/app')).signed).toBe(true);
  });
});

describe('astratra publish windows|mac|desktop', () => {
  test('--dry-run shows the app, the version, the targets and the installers, and touches nothing', async () => {
    const { root, config } = setupProject();
    const run = fakeBuilder(root);
    const opts = options(root, { runProcess: run, _target: 'desktop', 'dry-run': true });
    const result = await runPublish(root, config, opts);
    expect(result).toMatchObject({ exitCode: 0, dryRun: true, version: '1.0.1' });
    expect(result.artifacts.windows).toEqual([path.join(root, 'desktop/release/acme-bureau-1.0.1-setup-x64.exe')]);
    expect(result.artifacts.mac).toContain(path.join(root, 'desktop/release/acme-bureau-1.0.1-mac-arm64.dmg'));
    expect(opts.output.lines.join('\n')).toMatch(/Wine/);
    expect(run.calls).toHaveLength(0);
    expect(versionOf(root)).toBe('1.0.0');
  });

  test('windows: version bumped, renderer built, electron-builder run with a generated configuration, installer listed', async () => {
    const { root, config } = setupProject();
    const run = fakeBuilder(root);
    const result = await runPublish(root, config, options(root, { runProcess: run, _target: 'windows' }));
    expect(result).toMatchObject({ exitCode: 0, version: '1.0.1', bumped: true });
    expect(versionOf(root)).toBe('1.0.1');
    expect(run.calls[0]).toMatchObject({ command: 'npm', args: ['run', 'build'] });
    expect(run.calls[0].options.cwd).toBe(path.join(root, 'desktop'));
    const builder = run.calls[1];
    expect(builder.command).toBe('npx');
    expect(builder.args.slice(0, 4)).toEqual(['--no', '--', 'electron-builder', '--win']);
    expect(builder.args).toEqual(expect.arrayContaining(['--publish=never', `--projectDir=${path.join(root, 'desktop')}`]));
    expect(result.results[0].artifacts.map((a) => path.basename(a.path))).toEqual(['acme-bureau-1.0.1-setup-x64.exe']);
    expect(fs.existsSync(builder.args.find((a) => a.startsWith('--config=')).slice('--config='.length))).toBe(false);
  });

  test('--bump=none keeps the version; --out sends the installers elsewhere', async () => {
    const { root, config } = setupProject();
    const run = fakeBuilder(root);
    const result = await runPublish(root, config, options(root, { runProcess: run, _target: 'mac', bump: 'none', out: 'dist-bureau' }));
    expect(result.exitCode).toBe(0);
    expect(versionOf(root)).toBe('1.0.0');
    expect(result.results[0].artifacts[0].path).toBe(path.join(root, 'dist-bureau', 'acme-bureau-1.0.0-mac-arm64.dmg'));
  });

  test('a failed build puts the version back; a refused configuration bumps nothing', async () => {
    const { root, config } = setupProject();
    const failed = await runPublish(root, config, options(root, { runProcess: fakeBuilder(root, { fails: ['windows'] }), _target: 'windows' }));
    expect(failed).toMatchObject({ exitCode: 1, error: { code: 'DESKTOP_BUILD_FAILED' } });
    expect(failed.error.message).toMatch(/Wine/);
    expect(versionOf(root)).toBe('1.0.0');

    const refused = await runPublish(root, { publish: { desktop: { appDir: 'desktop' } } }, options(root, { runProcess: fakeBuilder(root), _target: 'windows' }));
    expect(refused).toMatchObject({ exitCode: 1, error: { code: 'DESKTOP_CONFIG_INVALID' } });
    expect(versionOf(root)).toBe('1.0.0');
  });

  test('without electron-builder installed in the app, nothing moves', async () => {
    const { root, config } = setupProject();
    const run = fakeBuilder(root);
    const result = await runPublish(root, config, options(root, { runProcess: run, _target: 'windows', electronBuilderInstalled: () => false }));
    expect(result.error.code).toBe('DESKTOP_BUILDER_MISSING');
    expect(run.calls).toHaveLength(0);
    expect(versionOf(root)).toBe('1.0.0');
  });

  test('signing required and no certificate: refused before the version moves', async () => {
    const { root, config } = setupProject({ desktop: { signing: { windows: 'required', mac: 'auto' } } });
    const result = await runPublish(root, config, options(root, { runProcess: fakeBuilder(root), _target: 'windows' }));
    expect(result.error.code).toBe('DESKTOP_SIGNING_MISSING');
    expect(versionOf(root)).toBe('1.0.0');
  });

  test('desktop builds every configured platform, Windows first', async () => {
    const { root, config } = setupProject();
    const run = fakeBuilder(root);
    const result = await runPublish(root, config, options(root, { runProcess: run, _target: 'desktop' }));
    expect(result.results.map((r) => [r.platform, r.ok])).toEqual([['windows', true], ['mac', true]]);
  });

  test('an unknown --bump is refused', async () => {
    const { root, config } = setupProject();
    const result = await runPublish(root, config, options(root, { runProcess: fakeBuilder(root), _target: 'windows', bump: 'huge' }));
    expect(result.error.code).toBe('VERSION_LEVEL_INVALID');
  });
});

describe('npm and npx on Windows', () => {
  test('go through cmd.exe with quoted arguments; nothing changes elsewhere', () => {
    expect(windowsCommand('npx', ['--no', '--', 'electron-builder', '--config=C:\\Temp dir\\eb.json'], 'win32'))
      .toEqual({ command: 'npx.cmd', args: ['--no', '--', 'electron-builder', '"--config=C:\\Temp dir\\eb.json"'] });
    expect(windowsCommand('npx', ['x'], 'darwin')).toBeNull();
    expect(windowsCommand('git', ['x'], 'win32')).toBeNull();
  });
});
