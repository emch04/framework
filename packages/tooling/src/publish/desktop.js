const fs = require('fs');
const path = require('path');
const { ToolingError } = require('../errors');

/**
 * Desktop apps (Electron) built with electron-builder: an NSIS installer (.exe)
 * for Windows, a .dmg and a .zip for macOS. Pure helpers — the command that
 * runs them is in commands/publish.js.
 *
 * The electron-builder configuration is generated from `publish.desktop` and
 * passed as a temporary file: the app keeps no electron-builder file of its own,
 * and nothing is ever published by electron-builder (`--publish never`).
 */

const DESKTOP_PLATFORMS = ['windows', 'mac'];
const PLATFORM_FLAG = { windows: '--win', mac: '--mac' };
const KNOWN_TARGETS = { windows: ['nsis', 'portable', 'zip', 'msi'], mac: ['dmg', 'zip', 'pkg'] };
const KNOWN_ARCHS = ['x64', 'arm64', 'ia32', 'universal'];
const ARTIFACT_EXTENSIONS = { windows: ['.exe', '.msi', '.zip'], mac: ['.dmg', '.zip', '.pkg'] };
const APP_ID = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
const SIGNING_MODES = ['auto', 'required', 'off'];

const DESKTOP_DEFAULTS = {
  // Folder of the Electron app (its package.json has `main`), relative to the project.
  appDir: null,
  appId: null,
  // Name shown to people (installer, Start menu, Applications); default: productName or name of package.json.
  productName: null,
  // Platforms of `publish desktop`.
  platforms: ['windows', 'mac'],
  icons: { windows: 'build/icon.ico', mac: 'build/icon.icns' },
  targets: { windows: ['nsis'], mac: ['dmg', 'zip'] },
  arch: { windows: ['x64'], mac: ['arm64', 'x64'] },
  // Relative to appDir. Never inside the renderer output, which electron-builder packs.
  outputDir: 'release',
  // npm script run in appDir before packaging (the renderer build); null = none.
  buildScript: 'build',
  // Files packed into the app (electron-builder globs); null = electron-builder's default (the whole appDir, without devDependencies).
  files: null,
  versionBump: 'patch',
  // 'auto': electron-builder signs when it finds a certificate; 'required': refuses to build unsigned; 'off': never signs.
  signing: { windows: 'auto', mac: 'auto' },
  // NSIS installer: per user by default (no administrator rights needed), with a choice of folder.
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  // Extra electron-builder options merged last (category, protocols, extraResources…).
  electronBuilder: null,
  // `--no`: never downloads electron-builder on the fly (it is a devDependency of the app);
  // `--`: what follows goes to electron-builder, not to npm (npx took --config and --publish for itself).
  command: ['npx', '--no', '--', 'electron-builder']
};

/* electron-builder reads the Electron version from package.json and refuses a range ("^44.5.1"):
   the version actually installed for the app (its node_modules, or a workspace root above) is given instead. */
function installedElectronVersion(appDir) {
  try {
    const file = require.resolve('electron/package.json', { paths: [appDir] });
    const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch (_error) {
    return null;
  }
}

/** Is electron-builder installed for this app (its own node_modules, or a workspace root above)? */
function electronBuilderInstalled(appDir) {
  try {
    require.resolve('electron-builder/package.json', { paths: [appDir] });
    return true;
  } catch (_error) {
    return false;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function fail(message) {
  throw new ToolingError('DESKTOP_CONFIG_INVALID', `publish.desktop : ${message}`, 400);
}

function listOf(value, name, allowed) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item)) {
    fail(`${name} doit etre une liste non vide.`);
  }
  if (allowed) {
    const unknown = value.filter((item) => !allowed.includes(item));
    if (unknown.length) fail(`${name} : ${unknown.join(', ')} inconnu (possible : ${allowed.join(', ')}).`);
  }
  return [...new Set(value)];
}

function readAppPackage(appDir) {
  const file = path.join(appDir, 'package.json');
  if (!fs.existsSync(file)) fail(`package.json introuvable dans ${appDir} (appDir doit etre le dossier de l'application Electron).`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    return fail(`package.json illisible dans ${appDir}.`);
  }
}

/**
 * Checks and completes `publish.desktop`. Every refusal names what is missing,
 * before anything is built or bumped.
 */
function resolveDesktopConfig(projectDir, input, merge) {
  if (!isPlainObject(input)) fail('section absente de astratra.config.json (publish.desktop : appDir, appId…).');
  const merged = merge(DESKTOP_DEFAULTS, input);
  if (typeof merged.appDir !== 'string' || !merged.appDir) fail('appDir manquant (dossier de l\'application Electron).');
  const appDir = path.resolve(projectDir, merged.appDir);
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) fail(`appDir introuvable : ${appDir}.`);
  const pkg = readAppPackage(appDir);
  if (typeof pkg.main !== 'string' || !pkg.main) fail(`le package.json de ${appDir} n'a pas de "main" (le fichier principal d'Electron).`);
  if (typeof merged.appId !== 'string' || !APP_ID.test(merged.appId)) fail('appId manquant ou mal forme (forme inverse de domaine, par exemple cd.examen-etat.bureau).');
  const productName = merged.productName || pkg.productName || pkg.name;
  if (typeof productName !== 'string' || !productName.trim()) fail('productName manquant.');

  const platforms = listOf(merged.platforms, 'platforms', DESKTOP_PLATFORMS);
  const targets = {};
  const arch = {};
  const icons = {};
  const signing = {};
  for (const platform of DESKTOP_PLATFORMS) {
    targets[platform] = listOf(merged.targets[platform], `targets.${platform}`, KNOWN_TARGETS[platform]);
    arch[platform] = listOf(merged.arch[platform], `arch.${platform}`, KNOWN_ARCHS);
    const mode = merged.signing[platform];
    if (!SIGNING_MODES.includes(mode)) fail(`signing.${platform} : ${SIGNING_MODES.join(', ')}.`);
    signing[platform] = mode;
    const icon = merged.icons[platform];
    icons[platform] = icon ? path.resolve(appDir, icon) : null;
  }
  for (const platform of platforms) {
    if (!icons[platform] || !fs.existsSync(icons[platform])) {
      fail(`icone ${platform} introuvable : ${icons[platform] || '(aucune)'} (icons.${platform}, ${platform === 'windows' ? '.ico de 256 px' : '.icns'}).`);
    }
  }
  if (typeof merged.outputDir !== 'string' || !merged.outputDir) fail('outputDir doit etre un dossier.');
  const outputDir = path.resolve(appDir, merged.outputDir);
  if (outputDir === appDir) fail('outputDir ne peut pas etre le dossier de l\'application elle-meme.');
  if (merged.buildScript !== null && (typeof merged.buildScript !== 'string' || !merged.buildScript)) fail('buildScript : nom d\'un script npm, ou null.');
  if (merged.buildScript && !(pkg.scripts && pkg.scripts[merged.buildScript])) {
    fail(`le script npm "${merged.buildScript}" n'existe pas dans ${appDir}/package.json (buildScript, ou null pour aucun).`);
  }
  if (merged.files !== null) listOf(merged.files, 'files');
  if (!['patch', 'minor', 'major', 'none'].includes(merged.versionBump)) fail('versionBump : patch, minor, major ou none.');
  if (merged.electronBuilder !== null && !isPlainObject(merged.electronBuilder)) fail('electronBuilder doit etre un objet.');
  if (!Array.isArray(merged.command) || !merged.command.length) fail('command doit etre une liste (par exemple ["npx", "electron-builder"]).');

  const electronVersion = installedElectronVersion(appDir);
  return { ...merged, appDir, productName: productName.trim(), version: pkg.version, electronVersion, platforms, targets, arch, icons, signing, outputDir };
}

/* File names of the installers: plain letters, digits and dashes (they travel through links and e-mails;
   a scoped package name such as @org/desktop would make a folder). */
function fileSlug(productName) {
  const slug = String(productName).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'app';
}

/** The electron-builder configuration for one run (written to a temporary file). */
function electronBuilderConfig(desktop, merge) {
  const forPlatform = (platform) => desktop.targets[platform].map((target) => ({ target, arch: desktop.arch[platform] }));
  const slug = fileSlug(desktop.productName);
  const base = {
    appId: desktop.appId,
    productName: desktop.productName,
    ...(desktop.electronVersion ? { electronVersion: desktop.electronVersion } : {}),
    directories: { output: desktop.outputDir, buildResources: 'build' },
    ...(desktop.files ? { files: desktop.files } : {}),
    win: { target: forPlatform('windows'), icon: desktop.icons.windows, artifactName: `${slug}-\${version}-win-\${arch}.\${ext}` },
    nsis: { ...desktop.nsis, artifactName: `${slug}-\${version}-setup-\${arch}.\${ext}`, installerIcon: desktop.icons.windows, uninstallerIcon: desktop.icons.windows },
    mac: { target: forPlatform('mac'), icon: desktop.icons.mac, artifactName: `${slug}-\${version}-mac-\${arch}.\${ext}` },
    publish: null
  };
  return desktop.electronBuilder ? merge(base, desktop.electronBuilder) : base;
}

function buildElectronBuilderArgs({ platform, configFile, appDir }) {
  if (!PLATFORM_FLAG[platform]) throw new ToolingError('DESKTOP_PLATFORM_INVALID', `Plateforme de bureau inconnue : ${platform}`, 400);
  return [PLATFORM_FLAG[platform], `--config=${configFile}`, `--projectDir=${appDir}`, '--publish=never'];
}

/* A certificate given as a file path must live outside the project: a certificate in a repository leaks with it. */
function certificatePath(value, homeDir) {
  if (typeof value !== 'string' || !value) return null;
  if (/^https?:/.test(value) || /^[A-Za-z0-9+/=\s]{200,}$/.test(value)) return null; // base64 or address: not a file
  return path.resolve(value.replace(/^~(?=$|\/)/, homeDir));
}

function insideDir(file, dir) {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The signing environment of one platform, from the environment only.
 * Returns { env, signed, note } — env is what electron-builder receives.
 */
function signingEnv(platform, mode, env, { projectDir, homeDir }) {
  const out = { ...env };
  const link = platform === 'windows' ? (env.WIN_CSC_LINK || env.CSC_LINK) : env.CSC_LINK;
  const name = platform === 'mac' ? env.CSC_NAME : null;
  const file = certificatePath(link, homeDir);
  if (file && insideDir(file, projectDir)) {
    throw new ToolingError('DESKTOP_CERTIFICATE_IN_PROJECT', `Le certificat ${platform} est dans le projet (${file}) : gardez-le hors de tout depot et donnez son chemin par l'environnement.`, 400);
  }
  if (mode === 'off') {
    for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_NAME']) delete out[key];
    out.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    return { env: out, signed: false, note: 'sans signature (signing: off)' };
  }
  const hasCertificate = Boolean(link || name);
  if (mode === 'required' && !hasCertificate) {
    const wanted = platform === 'windows' ? 'WIN_CSC_LINK (ou CSC_LINK) et WIN_CSC_KEY_PASSWORD' : 'CSC_LINK et CSC_KEY_PASSWORD, ou CSC_NAME';
    throw new ToolingError('DESKTOP_SIGNING_MISSING', `Signature ${platform} exigee (signing.${platform}: required) : ${wanted} absents de l'environnement.`, 400);
  }
  if (!hasCertificate && platform === 'windows') {
    return { env: out, signed: false, note: 'non signe : Windows SmartScreen avertira a l\'installation' };
  }
  return { env: out, signed: hasCertificate ? true : null, note: hasCertificate ? 'signe' : 'signature si une identite est dans le trousseau' };
}

/** Installers produced by this run: files of the output folder written since `since`. */
function listArtifacts(outputDir, platform, since) {
  if (!fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir)
    .filter((name) => ARTIFACT_EXTENSIONS[platform].includes(path.extname(name).toLowerCase()))
    .map((name) => path.join(outputDir, name))
    .filter((file) => fs.statSync(file).isFile() && fs.statSync(file).mtimeMs >= since)
    .map((file) => ({ path: file, size: fs.statSync(file).size }));
}

/** What a run would produce, for --dry-run: file names only, nothing built. */
function expectedArtifacts(desktop, platform, version) {
  const name = fileSlug(desktop.productName);
  const files = [];
  for (const target of desktop.targets[platform]) {
    for (const arch of desktop.arch[platform]) {
      if (target === 'nsis') files.push(`${name}-${version}-setup-${arch}.exe`);
      else files.push(`${name}-${version}-${platform === 'windows' ? 'win' : 'mac'}-${arch}.${target === 'portable' ? 'exe' : target}`);
    }
  }
  return files.map((file) => path.join(desktop.outputDir, file));
}

module.exports = {
  DESKTOP_DEFAULTS,
  DESKTOP_PLATFORMS,
  buildElectronBuilderArgs,
  electronBuilderConfig,
  electronBuilderInstalled,
  expectedArtifacts,
  fileSlug,
  installedElectronVersion,
  listArtifacts,
  resolveDesktopConfig,
  signingEnv
};
