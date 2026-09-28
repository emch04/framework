const fs = require('fs');
const path = require('path');
const { ToolingError } = require('../errors');
const { runProcess } = require('../processRunner');

/**
 * The native fingerprint is a hash of everything that ends up in the native
 * binary (native modules, config plugins, permissions, icons...). The hash of
 * the last build that reached a store is kept in a small file; a different
 * hash means the next build carries new native code and needs a new version,
 * so that an over-the-air update made for the old binary never reaches it.
 */

function readPublishedFingerprint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  const value = fs.readFileSync(filePath, 'utf8').trim();
  return value || null;
}

function recordPublishedFingerprint(filePath, hash) {
  if (typeof hash !== 'string' || !hash.trim()) {
    throw new ToolingError('FINGERPRINT_EMPTY', 'Empreinte native vide : rien n\'est enregistre.', 400);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${hash.trim()}\n`);
  return hash.trim();
}

/**
 * Pure decision. `current` is the fingerprint of the tree about to be built,
 * `published` the one recorded after the last published build (or null).
 */
function decideVersionBump({ current, published }) {
  if (typeof current !== 'string' || !current.trim()) {
    throw new ToolingError('FINGERPRINT_EMPTY', 'Empreinte native actuelle vide : impossible de decider de la version.', 400);
  }

  if (!published) {
    return { bump: true, reason: 'no-published-fingerprint' };
  }

  if (published.trim() !== current.trim()) {
    return { bump: true, reason: 'native-changed' };
  }

  return { bump: false, reason: 'native-unchanged' };
}

function extractHash(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value && typeof value.hash === 'string') {
    return value.hash.trim();
  }

  return '';
}

function loadFingerprintModule(projectDir) {
  const candidates = [projectDir, __dirname];
  for (const base of candidates) {
    try {
      const resolved = require.resolve('@expo/fingerprint', { paths: [base] });
      return require(resolved);
    } catch (_error) {
      // try the next base
    }
  }
  return null;
}

/**
 * Computes the fingerprint of `projectDir`, in this order:
 * 1. `options.compute(projectDir)` — injected (tests, custom hashing);
 * 2. `options.command` — an argv whose stdout is the JSON of `@expo/fingerprint`
 *    (e.g. ['npx', '@expo/fingerprint', '.']), run in `projectDir`;
 * 3. the optional peer `@expo/fingerprint` (`createFingerprintAsync`).
 */
async function computeFingerprint(projectDir, options = {}) {
  let hash = '';

  if (typeof options.compute === 'function') {
    hash = extractHash(await options.compute(projectDir));
  } else if (Array.isArray(options.command) && options.command.length > 0) {
    const run = options.runProcess || runProcess;
    const [command, ...args] = options.command;
    const result = await run(command, args, { cwd: projectDir, quiet: true });
    if (result.code !== 0) {
      throw new ToolingError('FINGERPRINT_FAILED', `Le calcul de l'empreinte native a echoue (code ${result.code}).`, 500);
    }
    try {
      hash = extractHash(JSON.parse(result.stdout));
    } catch (_error) {
      throw new ToolingError('FINGERPRINT_FAILED', 'La sortie du calcul d\'empreinte n\'est pas du JSON.', 500);
    }
  } else {
    const loaded = (options.loadModule || loadFingerprintModule)(projectDir);
    if (!loaded || typeof loaded.createFingerprintAsync !== 'function') {
      throw new ToolingError(
        'FINGERPRINT_UNAVAILABLE',
        'Empreinte native indisponible : installez @expo/fingerprint dans le projet, ou configurez publish.fingerprint.command.',
        500
      );
    }
    hash = extractHash(await loaded.createFingerprintAsync(projectDir));
  }

  if (!hash) {
    throw new ToolingError('FINGERPRINT_EMPTY', 'Le calcul de l\'empreinte native n\'a rendu aucun hash.', 500);
  }

  return hash;
}

/**
 * Reads `expo.runtimeVersion` from app.json when there is one. The automatic
 * bump only protects installed apps if the runtime version follows the app
 * version; a dynamic app.config.js cannot be read here and yields 'unknown'.
 */
function readRuntimeVersionPolicy(projectDir) {
  const appJson = path.join(projectDir, 'app.json');
  if (!fs.existsSync(appJson)) {
    return 'unknown';
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(appJson, 'utf8'));
    const runtimeVersion = parsed && parsed.expo ? parsed.expo.runtimeVersion : undefined;
    if (runtimeVersion === undefined) {
      return 'unset';
    }
    if (typeof runtimeVersion === 'string') {
      return 'fixed';
    }
    return runtimeVersion.policy || 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

module.exports = {
  computeFingerprint,
  decideVersionBump,
  readPublishedFingerprint,
  readRuntimeVersionPolicy,
  recordPublishedFingerprint
};
