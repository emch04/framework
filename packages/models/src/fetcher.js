
/**
 * Downloading the pinned models and verifying what is on disk.
 *
 * `fetchModels` downloads exactly the files of the manifest, at the commit
 * they are pinned to, and checks the SHA-256 of each one: a file that does not
 * match is deleted and the call fails, nothing unverified is ever left in
 * place. A download goes to `<file>.part` and is resumed from where it stopped.
 * `checkModels` verifies what is present, without the network.
 *
 * Nothing runs at install time and no weight ships with the package: this is
 * called by hand (`astratra-models fetch`) or from a deploy step.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadManifest, listFiles, incompleteFiles, selectModels } = require('./manifest');

const DEFAULT_ENDPOINT = 'https://huggingface.co';
const CHUNK = 4 * 1024 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

class ManifestIncompleteError extends Error {
  constructor(files) {
    super(`${files.length} file(s) have no SHA-256 in the manifest (${files.slice(0, 3).map((f) => `${f.model}/${f.path}`).join(', ')}${files.length > 3 ? ', ...' : ''}): refusing to download what cannot be verified.`);
    this.name = 'ManifestIncompleteError';
    this.code = 'MANIFEST_INCOMPLETE';
    this.files = files.map((f) => ({ model: f.model, path: f.path }));
  }
}

class ChecksumError extends Error {
  constructor(file, actual) {
    super(`${file.model}/${file.path}: SHA-256 mismatch (expected ${file.sha256}, got ${actual}); the file was deleted.`);
    this.name = 'ChecksumError';
    this.code = 'CHECKSUM_MISMATCH';
    this.model = file.model;
    this.path = file.path;
  }
}

/** SHA-256 of a file, read in chunks (synchronous: a startup check, not a request path). */
function hashFileSync(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK);
  const descriptor = fs.openSync(file, 'r');
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, CHUNK, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: CHUNK });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function requireDir(dir) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('dir: the models directory is required (option dir, or MODELS_DIR).');
  return path.resolve(dir);
}

function fileState(file, verify) {
  let stat;
  try {
    stat = fs.statSync(file.absolute);
  } catch (_error) {
    return 'missing';
  }
  if (!stat.isFile() || stat.size !== file.size) return 'altered';
  if (verify === 'size') return 'ok';
  return hashFileSync(file.absolute) === file.sha256 ? 'ok' : 'altered';
}

/**
 * Verifies the files of the selected models under `dir`, without the network.
 * @param {object} options { dir, models?, manifest?, verify? 'sha256' (default) | 'size' }
 * @returns {{ ok: boolean, models: Record<string, { status: 'ok'|'missing'|'altered', files: Array<{ path: string, status: string }> }> }}
 */
function checkModels(options = {}) {
  const dir = requireDir(options.dir);
  const manifest = options.manifest || loadManifest();
  const verify = options.verify === undefined ? 'sha256' : options.verify;
  if (verify !== 'sha256' && verify !== 'size') throw new TypeError("verify: 'sha256' or 'size'.");
  const names = selectModels(manifest, options.models);
  const missingHash = incompleteFiles(manifest, names);
  if (missingHash.length) throw new ManifestIncompleteError(missingHash);
  const models = {};
  for (const name of names) {
    const files = listFiles(manifest, [name], dir).map((file) => ({ path: file.relative, status: fileState(file, verify) }));
    const status = files.some((f) => f.status === 'altered') ? 'altered' : files.some((f) => f.status === 'missing') ? 'missing' : 'ok';
    models[name] = { status, files };
  }
  return { ok: Object.values(models).every((m) => m.status === 'ok'), models };
}

function endpointOf(value) {
  const raw = String(value || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch (_error) { throw new TypeError('endpoint: an absolute URL is required.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new TypeError('endpoint: https is required (http only for a loopback address).');
  }
  return raw;
}

async function writeBody(body, target, flags) {
  const stream = fs.createWriteStream(target, { flags });
  try {
    for await (const chunk of body) {
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve));
    }
  } finally {
    await new Promise((resolve, reject) => {
      stream.once('error', reject);
      stream.end(resolve);
    });
  }
}

const sizeOf = (file) => {
  try { return fs.statSync(file).size; } catch (_error) { return 0; }
};

/* One file: resume `.part`, verify the hash, then move into place. */
async function downloadFile(file, options) {
  const { fetchImpl, endpoint, attempts, onEvent } = options;
  const part = `${file.absolute}.part`;
  fs.mkdirSync(path.dirname(file.absolute), { recursive: true });
  const url = `${endpoint}/${file.repo}/resolve/${file.revision}/${file.path}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      let have = sizeOf(part);
      if (have > file.size) { fs.rmSync(part, { force: true }); have = 0; }
      if (have < file.size) {
        const response = await fetchImpl(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' });
        let flags = 'a';
        if (response.status === 206) {
          const range = /^bytes (\d+)-/.exec(response.headers.get('content-range') || '');
          if (!range || Number(range[1]) !== have) { fs.rmSync(part, { force: true }); throw new Error('unexpected Content-Range, restarting'); }
        } else if (response.status === 200) {
          flags = 'w';
        } else if (response.status === 416) {
          fs.rmSync(part, { force: true });
          throw new Error('range not satisfiable, restarting');
        } else {
          const error = new Error(`${file.repo}/${file.path}: HTTP ${response.status}`);
          error.fatal = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
          throw error;
        }
        if (!response.body) throw new Error('empty response body');
        onEvent({ type: 'download', model: file.model, path: file.relative, resumedAt: flags === 'a' ? have : 0, size: file.size });
        await writeBody(response.body, part, flags);
      }
      const written = sizeOf(part);
      if (written < file.size) throw new Error(`incomplete download (${written} of ${file.size} bytes)`);
      const actual = await hashFile(part);
      if (written !== file.size || actual !== file.sha256) {
        fs.rmSync(part, { force: true });
        throw new ChecksumError(file, actual);
      }
      fs.renameSync(part, file.absolute);
      return;
    } catch (error) {
      if (error instanceof ChecksumError || error.fatal) throw error;
      lastError = error;
      onEvent({ type: 'retry', model: file.model, path: file.relative, attempt, message: error.message });
    }
  }
  throw lastError;
}

/**
 * Downloads the selected models to `dir`, verified.
 * @param {object} options { dir, models?, manifest?, fetch?, endpoint?, attempts? (default 3), onEvent? }
 * @returns {Promise<{ ok: true, models: Record<string, { downloaded: string[], present: string[] }> }>}
 */
async function fetchModels(options = {}) {
  const dir = requireDir(options.dir);
  const manifest = options.manifest || loadManifest();
  const names = selectModels(manifest, options.models);
  const missingHash = incompleteFiles(manifest, names);
  if (missingHash.length) throw new ManifestIncompleteError(missingHash);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch function is required.');
  const endpoint = endpointOf(options.endpoint || process.env.HF_ENDPOINT);
  const attempts = Math.max(1, Math.floor(options.attempts || 3));
  const onEvent = typeof options.onEvent === 'function' ? (event) => { try { options.onEvent(event); } catch (_error) { /* observers never break a download */ } } : () => {};
  const report = {};
  for (const name of names) {
    report[name] = { downloaded: [], present: [] };
    for (const file of listFiles(manifest, [name], dir)) {
      if (fileState(file, 'sha256') === 'ok') {
        report[name].present.push(file.relative);
        onEvent({ type: 'present', model: name, path: file.relative });
        continue;
      }
      /* A file in place that does not match is an altered file: it goes. */
      fs.rmSync(file.absolute, { force: true });
      await downloadFile(file, { fetchImpl, endpoint, attempts, onEvent });
      report[name].downloaded.push(file.relative);
      onEvent({ type: 'verified', model: name, path: file.relative });
    }
  }
  return { ok: true, models: report };
}

module.exports = {
  fetchModels,
  checkModels,
  hashFile,
  hashFileSync,
  ManifestIncompleteError,
  ChecksumError,
  DEFAULT_ENDPOINT
};
