/* global fetch */
const fs = require('fs');
const path = require('path');
const { ToolingError } = require('../errors');

const PLATFORMS = new Set(['ios', 'android']);
const FAILED_STATUSES = new Set(['ERRORED', 'CANCELED', 'CANCELLED']);

function assertPlatform(platform) {
  if (!PLATFORMS.has(platform)) {
    throw new ToolingError('PUBLISH_PLATFORM_INVALID', `Plateforme inconnue : ${platform} (ios ou android).`, 400);
  }
}

function archiveExtension(platform) {
  assertPlatform(platform);
  return platform === 'ios' ? 'ipa' : 'aab';
}

function buildEasBuildArgs({ platform, profile = 'production' }) {
  assertPlatform(platform);
  return ['build', '-p', platform, '--profile', profile, '--non-interactive', '--no-wait', '--json'];
}

/** Build on this machine: eas-cli writes the archive straight to `output`, nothing to poll or download. */
function buildEasLocalBuildArgs({ platform, profile = 'production', output }) {
  assertPlatform(platform);
  if (!output || !path.isAbsolute(String(output))) {
    throw new ToolingError('EAS_LOCAL_OUTPUT_INVALID', `Chemin de sortie du build local invalide : ${output}`, 400);
  }
  return ['build', '-p', platform, '--profile', profile, '--local', '--non-interactive', '--output', String(output)];
}

function buildEasViewArgs(buildId) {
  if (!/^[A-Za-z0-9-]+$/.test(String(buildId || ''))) {
    throw new ToolingError('EAS_BUILD_ID_INVALID', `Identifiant de build invalide : ${buildId}`, 400);
  }
  return ['build:view', buildId, '--json'];
}

function buildEasUpdateArgs({ channel = 'production', message }) {
  if (!message || !String(message).trim()) {
    throw new ToolingError('EAS_UPDATE_MESSAGE_MISSING', 'Une mise a jour a distance demande un message.', 400);
  }
  return ['update', '--channel', channel, '--message', String(message), '--non-interactive'];
}

function parseJson(stdout, code, what) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch (_error) {
    throw new ToolingError(code, `${what} : la reponse d'eas-cli n'est pas du JSON.`, 502);
  }
}

function parseBuildStart(stdout) {
  const parsed = parseJson(stdout, 'EAS_BUILD_START_FAILED', 'Lancement du build');
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || !first.id) {
    throw new ToolingError('EAS_BUILD_START_FAILED', 'eas-cli n\'a rendu aucun identifiant de build.', 502);
  }
  return first.id;
}

function parseBuildView(stdout) {
  const parsed = parseJson(stdout, 'EAS_BUILD_VIEW_FAILED', 'Etat du build');
  const artifacts = parsed.artifacts || {};
  return {
    status: String(parsed.status || 'UNKNOWN').toUpperCase(),
    url: artifacts.applicationArchiveUrl || artifacts.buildUrl || null,
    buildNumber: parsed.appBuildVersion || null,
    appVersion: parsed.appVersion || null
  };
}

/**
 * Polls until FINISHED. Unlike a bare `while true`, a status that cannot be
 * read is retried a bounded number of times, and the whole wait has a ceiling.
 */
async function waitForBuild(options) {
  const {
    buildId,
    view,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs = 60000,
    timeoutMs = 3 * 60 * 60 * 1000,
    maxViewFailures = 5,
    onStatus = () => {},
    now = () => Date.now()
  } = options;

  const startedAt = now();
  let failures = 0;

  for (;;) {
    let state = null;
    try {
      state = await view(buildId);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= maxViewFailures) {
        throw new ToolingError('EAS_BUILD_VIEW_FAILED', `Etat du build ${buildId} illisible ${failures} fois de suite.`, 502, { cause: error.code });
      }
    }

    if (state) {
      onStatus(state);
      if (state.status === 'FINISHED') {
        if (!state.url) {
          throw new ToolingError('EAS_ARTIFACT_MISSING', `Build ${buildId} fini sans fichier telechargeable.`, 502);
        }
        return state;
      }
      if (FAILED_STATUSES.has(state.status)) {
        throw new ToolingError('EAS_BUILD_FAILED', `Le build ${buildId} n'a pas abouti (${state.status}).`, 502);
      }
    }

    if (now() - startedAt + intervalMs > timeoutMs) {
      throw new ToolingError('EAS_BUILD_TIMEOUT', `Le build ${buildId} n'est pas fini apres ${Math.round(timeoutMs / 60000)} min.`, 504);
    }
    await sleep(intervalMs);
  }
}

function safePart(value) {
  return String(value === null || value === undefined ? 'x' : value).replace(/[^A-Za-z0-9._-]/g, '-');
}

function artifactFileName({ appName, platform, version, buildNumber, template }) {
  const ext = archiveExtension(platform);
  const values = { app: safePart(appName), platform, version: safePart(version), build: safePart(buildNumber), ext };
  const pattern = template || '{app}-{platform}-{version}-{build}.{ext}';
  const name = pattern.replace(/\{(app|platform|version|build|ext)\}/g, (_match, key) => values[key]);
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new ToolingError('PUBLISH_FILENAME_INVALID', `Nom de fichier refuse : ${name}`, 400);
  }
  return name;
}

/** Downloads next to the target, then renames: a cut download never looks complete. */
async function downloadArtifact({ url, filePath, fetch: fetchImpl = typeof fetch === 'function' ? fetch : null }) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow' });
  } catch (error) {
    throw new ToolingError('ARTIFACT_DOWNLOAD_FAILED', `Telechargement impossible (${error && error.code ? error.code : 'reseau'}).`, 502);
  }
  if (!response.ok) {
    throw new ToolingError('ARTIFACT_DOWNLOAD_FAILED', `Telechargement refuse (${response.status}).`, 502);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new ToolingError('ARTIFACT_DOWNLOAD_FAILED', 'Le fichier telecharge est vide.', 502);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const partial = `${filePath}.part`;
  fs.writeFileSync(partial, buffer);
  fs.renameSync(partial, filePath);
  return { filePath, bytes: buffer.length };
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} Ko`;
  }
  return `${bytes} o`;
}

module.exports = {
  archiveExtension,
  artifactFileName,
  buildEasBuildArgs,
  buildEasLocalBuildArgs,
  buildEasUpdateArgs,
  buildEasViewArgs,
  downloadArtifact,
  formatBytes,
  parseBuildStart,
  parseBuildView,
  waitForBuild
};
