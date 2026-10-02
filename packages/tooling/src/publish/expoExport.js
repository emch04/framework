const fs = require('fs');
const path = require('path');
const { ToolingError } = require('../errors');

/*
 * Une mise a jour a distance se prepare ici, sur la machine, avec les reglages
 * du profil de build (eas.json) et non avec le .env du developpeur : celui-ci
 * pointe vers le serveur local (http://127.0.0.1:3000), et une mise a jour
 * qui le porterait couperait toutes les applications installees de leur
 * serveur. Le paquet prepare est ensuite relu : une adresse locale qui y
 * serait restee arrete tout avant l'envoi.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const PLATFORMS = ['ios', 'android'];

/** Les variables du profil, `extends` compris (le profil herite, puis surcharge). */
function readProfileEnv(projectDir, profile, seen = new Set()) {
  let easJson;
  try {
    easJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'eas.json'), 'utf8'));
  } catch (_error) {
    throw new ToolingError('EAS_JSON_UNREADABLE', `eas.json illisible dans ${projectDir}.`, 400);
  }
  const build = easJson.build && easJson.build[profile];
  if (!build) {
    throw new ToolingError('EAS_PROFILE_MISSING', `Profil « ${profile} » absent de eas.json.`, 400);
  }
  if (seen.has(profile)) {
    throw new ToolingError('EAS_PROFILE_LOOP', `Profils eas.json qui s'etendent en boucle : ${[...seen, profile].join(' → ')}.`, 400);
  }
  seen.add(profile);
  const inherited = build.extends ? readProfileEnv(projectDir, build.extends, seen) : {};
  return { ...inherited, ...(build.env || {}) };
}

/** Le .env du projet, lu seulement pour savoir ce qu'il ne faut PAS envoyer. */
function readDotEnv(projectDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
  } catch (_error) {
    return {};
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function isLoopbackUrl(value) {
  try {
    return LOOPBACK_HOSTS.has(new URL(String(value)).hostname);
  } catch (_error) {
    return false;
  }
}

/** Les variables publiques (EXPO_PUBLIC_*) qui pointent vers la machine elle-meme. */
function localPublicUrls(env) {
  return Object.entries(env)
    .filter(([name, value]) => name.startsWith('EXPO_PUBLIC_') && isLoopbackUrl(value))
    .map(([name, value]) => ({ name, value }));
}

function assertNoLocalUrl(env) {
  const local = localPublicUrls(env);
  if (local.length) {
    throw new ToolingError(
      'EAS_UPDATE_LOCAL_URL',
      `Mise a jour refusee : ${local.map((one) => one.name).join(', ')} pointe vers cette machine. Mettez l'adresse de production dans le profil de eas.json.`,
      400
    );
  }
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

/** Relit le paquet prepare (JavaScript ou bytecode Hermes, dont les chaines restent lisibles). */
function assertBundleClean(outputDir, needles) {
  const wanted = [...new Set(needles.filter(Boolean))];
  if (!wanted.length) return;
  const bundles = filesUnder(outputDir).filter((file) => /\.(hbc|js|bundle)$/.test(file));
  for (const file of bundles) {
    const content = fs.readFileSync(file).toString('latin1');
    const found = wanted.find((needle) => content.includes(needle));
    if (found) {
      throw new ToolingError('EAS_UPDATE_LOCAL_URL_IN_BUNDLE', `Mise a jour refusee : le paquet ${path.relative(outputDir, file)} contient encore ${found}.`, 400);
    }
  }
}

/** iPhone et Android seulement : le web, s'il est declare, n'a rien a faire dans une mise a jour mobile. */
function buildExpoExportArgs({ outputDir }) {
  if (!outputDir || !path.isAbsolute(String(outputDir))) {
    throw new ToolingError('EXPO_EXPORT_OUTPUT_INVALID', `Dossier de sortie invalide : ${outputDir}`, 400);
  }
  return ['export', ...PLATFORMS.flatMap((platform) => ['--platform', platform]), '--output-dir', String(outputDir)];
}

module.exports = {
  assertBundleClean,
  assertNoLocalUrl,
  buildExpoExportArgs,
  localPublicUrls,
  readDotEnv,
  readProfileEnv
};
