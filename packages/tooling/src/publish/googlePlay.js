/* global fetch */
const fs = require('fs');
const { URLSearchParams } = require('url');
const { ToolingError } = require('../errors');
const { signJwt } = require('./jwt');

const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD_BASE = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';
const RELEASE_STATUSES = new Set(['completed', 'draft', 'inProgress', 'halted']);
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const TRACK_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/**
 * The service-account key comes from a file path, or from an environment
 * variable NAME holding the JSON. The key itself is never returned in an
 * error, never logged.
 */
function loadServiceAccount({ path: keyPath, jsonEnv, env = process.env } = {}) {
  let raw;

  if (keyPath) {
    if (!fs.existsSync(keyPath)) {
      throw new ToolingError('PLAY_KEY_MISSING', `Cle du compte de service introuvable : ${keyPath}`, 400);
    }
    raw = fs.readFileSync(keyPath, 'utf8');
  } else if (jsonEnv) {
    raw = env[jsonEnv];
    if (!raw) {
      throw new ToolingError('PLAY_KEY_MISSING', `Variable d'environnement ${jsonEnv} absente ou vide.`, 400);
    }
  } else {
    throw new ToolingError('PLAY_KEY_MISSING', 'Aucune cle de compte de service configuree (serviceAccountPath ou serviceAccountJsonEnv).', 400);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    throw new ToolingError('PLAY_KEY_INVALID', 'La cle du compte de service n\'est pas du JSON valide.', 400);
  }

  if (!parsed || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    throw new ToolingError('PLAY_KEY_INVALID', 'La cle du compte de service doit contenir client_email et private_key.', 400);
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri || DEFAULT_TOKEN_URI
  };
}

/** Google's own error text says what blocks (version already used, track...); it is kept short. */
async function readGoogleError(response) {
  try {
    const body = await response.json();
    const message = body && body.error && (body.error.message || body.error_description || body.error);
    return typeof message === 'string' ? message.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 300) : '';
  } catch (_error) {
    return '';
  }
}

function createGooglePlayClient(options = {}) {
  const { packageName, serviceAccount } = options;
  const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch : null);
  const now = options.now || (() => Date.now());
  const apiBase = options.apiBase || API_BASE;
  const uploadBase = options.uploadBase || UPLOAD_BASE;

  if (!PACKAGE_NAME.test(String(packageName || ''))) {
    throw new ToolingError('PLAY_PACKAGE_INVALID', `Nom de paquet Android invalide : ${packageName}`, 400);
  }
  if (!serviceAccount || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new ToolingError('PLAY_KEY_MISSING', 'Cle du compte de service manquante.', 400);
  }
  if (!fetchImpl) {
    throw new ToolingError('PLAY_NO_FETCH', 'Aucune implementation de fetch disponible.', 500);
  }

  const appPath = encodeURIComponent(packageName);

  async function send(url, init) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      throw new ToolingError('PLAY_NETWORK', `Google Play injoignable (${error && error.code ? error.code : 'reseau'}).`, 502);
    }
  }

  async function getAccessToken() {
    const issuedAt = Math.floor(now() / 1000);
    const assertion = signJwt({
      algorithm: 'RS256',
      payload: {
        iss: serviceAccount.client_email,
        scope: PLAY_SCOPE,
        aud: serviceAccount.token_uri || DEFAULT_TOKEN_URI,
        iat: issuedAt,
        exp: issuedAt + 3600
      },
      privateKey: serviceAccount.private_key
    });

    const response = await send(serviceAccount.token_uri || DEFAULT_TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }).toString()
    });

    if (!response.ok) {
      throw new ToolingError('PLAY_TOKEN_REFUSED', `Google a refuse la cle du compte de service (${response.status}).`, 401);
    }

    const body = await response.json().catch(() => ({}));
    if (!body || typeof body.access_token !== 'string') {
      throw new ToolingError('PLAY_TOKEN_REFUSED', 'Google n\'a pas rendu de jeton d\'acces.', 401);
    }

    return body.access_token;
  }

  async function call(code, token, url, init = {}) {
    const response = await send(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) }
    });

    if (!response.ok) {
      const detail = await readGoogleError(response);
      throw new ToolingError(code, `Google Play a repondu ${response.status}${detail ? ` : ${detail}` : ''}`, response.status);
    }

    if (response.status === 204) {
      return {};
    }
    return response.json().catch(() => ({}));
  }

  /**
   * The edits flow: create an edit, upload the bundle into it, point the
   * track at the new version code, commit. An edit left open by a failure is
   * deleted (best effort) so it does not hold the next attempt.
   */
  async function uploadBundle(uploadOptions = {}) {
    const track = uploadOptions.track || 'internal';
    const releaseStatus = uploadOptions.releaseStatus || 'completed';

    if (!TRACK_NAME.test(track)) {
      throw new ToolingError('PLAY_TRACK_INVALID', `Nom de piste invalide : ${track}`, 400);
    }
    if (!RELEASE_STATUSES.has(releaseStatus)) {
      throw new ToolingError('PLAY_RELEASE_STATUS_INVALID', `Statut de version inconnu : ${releaseStatus}`, 400);
    }
    if (releaseStatus === 'inProgress' && !(uploadOptions.userFraction > 0 && uploadOptions.userFraction < 1)) {
      throw new ToolingError('PLAY_RELEASE_STATUS_INVALID', 'Un deploiement progressif demande userFraction entre 0 et 1.', 400);
    }

    let body = uploadOptions.body;
    if (!body) {
      if (!uploadOptions.filePath || !fs.existsSync(uploadOptions.filePath)) {
        throw new ToolingError('PLAY_BUNDLE_MISSING', `Fichier .aab introuvable : ${uploadOptions.filePath}`, 400);
      }
      body = fs.readFileSync(uploadOptions.filePath);
    }

    const token = await getAccessToken();
    const edit = await call('PLAY_EDIT_FAILED', token, `${apiBase}/${appPath}/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });

    if (!edit || !edit.id) {
      throw new ToolingError('PLAY_EDIT_FAILED', 'Google Play n\'a pas rendu d\'identifiant d\'edition.', 502);
    }

    const editPath = `${apiBase}/${appPath}/edits/${encodeURIComponent(edit.id)}`;

    try {
      const bundle = await call('PLAY_UPLOAD_FAILED', token, `${uploadBase}/${appPath}/edits/${encodeURIComponent(edit.id)}/bundles?uploadType=media`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body
      });

      if (!bundle || bundle.versionCode === undefined || bundle.versionCode === null) {
        throw new ToolingError('PLAY_UPLOAD_FAILED', 'Google Play n\'a pas rendu de code de version.', 502);
      }

      const release = {
        status: releaseStatus,
        versionCodes: [String(bundle.versionCode)]
      };
      if (uploadOptions.releaseName) {
        release.name = uploadOptions.releaseName;
      }
      if (releaseStatus === 'inProgress') {
        release.userFraction = uploadOptions.userFraction;
      }
      if (Array.isArray(uploadOptions.releaseNotes) && uploadOptions.releaseNotes.length > 0) {
        release.releaseNotes = uploadOptions.releaseNotes;
      }

      await call('PLAY_TRACK_FAILED', token, `${editPath}/tracks/${encodeURIComponent(track)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ track, releases: [release] })
      });

      const commitQuery = uploadOptions.changesNotSentForReview ? '?changesNotSentForReview=true' : '';
      await call('PLAY_COMMIT_FAILED', token, `${editPath}:commit${commitQuery}`, { method: 'POST' });

      return { versionCode: bundle.versionCode, editId: edit.id, track, packageName };
    } catch (error) {
      try {
        await fetchImpl(editPath, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      } catch (_cleanupError) {
        // the edit expires on its own; the original error matters more
      }
      throw error;
    }
  }

  return {
    getAccessToken,
    uploadBundle
  };
}

module.exports = {
  PLAY_SCOPE,
  createGooglePlayClient,
  loadServiceAccount
};
