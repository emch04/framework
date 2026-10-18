/**
 * The pinned list of every model the service can load: Hugging Face
 * repository, commit hash (never a branch), files with their size and SHA-256,
 * licence. Pure data helpers — nothing here touches the network.
 *
 * The manifest is data/models-manifest.json, written by
 * scripts/build-manifest.js and reviewed like code. A file whose `sha256` is
 * still to be completed (`null` or "TO_COMPLETE") makes `fetch` refuse to run:
 * downloading something that cannot be verified is never an option.
 */
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'models-manifest.json');
const TO_COMPLETE = 'TO_COMPLETE';

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;

function readManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* A relative path made of plain segments: no "..", no absolute path, no empty segment. */
function isSafeRelativePath(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\\') && value.split('/').every((part) => SEGMENT.test(part));
}

const isMissingHash = (value) => value === null || value === undefined || value === TO_COMPLETE;

/** Problems found in a manifest, as readable strings (empty when it is well formed). */
function manifestProblems(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || manifest.schema !== 1) return ['schema: 1 expected'];
  if (!manifest.models || typeof manifest.models !== 'object' || !Object.keys(manifest.models).length) {
    return ['models: at least one model expected'];
  }
  const folders = new Set();
  for (const [name, model] of Object.entries(manifest.models)) {
    const at = `models.${name}`;
    if (!/^[a-z][a-z0-9_]*$/.test(name)) problems.push(`${at}: invalid name`);
    if (!model || typeof model !== 'object') { problems.push(`${at}: object expected`); continue; }
    if (!isSafeRelativePath(model.folder)) problems.push(`${at}.folder: plain relative path expected`);
    else if (folders.has(model.folder)) problems.push(`${at}.folder: already used by another model`);
    else folders.add(model.folder);
    if (typeof model.license !== 'string' || !model.license) problems.push(`${at}.license: text expected`);
    if (model.optional !== undefined && typeof model.optional !== 'boolean') problems.push(`${at}.optional: boolean expected`);
    if (!Array.isArray(model.sources) || !model.sources.length) { problems.push(`${at}.sources: non-empty list expected`); continue; }
    model.sources.forEach((source, index) => {
      const where = `${at}.sources[${index}]`;
      if (!source || typeof source.repo !== 'string' || !REPO.test(source.repo)) problems.push(`${where}.repo: owner/name expected`);
      if (!source || typeof source.revision !== 'string' || !REVISION.test(source.revision)) {
        problems.push(`${where}.revision: a 40-character commit hash expected (a branch moves)`);
      }
      if (source && source.dir !== undefined && !isSafeRelativePath(source.dir)) problems.push(`${where}.dir: plain relative path expected`);
      if (!source || !Array.isArray(source.files) || !source.files.length) { problems.push(`${where}.files: non-empty list expected`); return; }
      const seen = new Set();
      for (const file of source.files) {
        if (!file || !isSafeRelativePath(file.path)) { problems.push(`${where}.files: unsafe or missing path`); continue; }
        if (seen.has(file.path)) problems.push(`${where}.files: ${file.path} listed twice`);
        seen.add(file.path);
        if (!Number.isInteger(file.size) || file.size < 0) problems.push(`${where}.files[${file.path}].size: non-negative integer expected`);
        if (!isMissingHash(file.sha256) && !(typeof file.sha256 === 'string' && SHA256.test(file.sha256))) {
          problems.push(`${where}.files[${file.path}].sha256: 64 hexadecimal characters, or ${TO_COMPLETE}`);
        }
      }
    });
  }
  return problems;
}

/** The manifest, or a TypeError listing what is wrong with it. */
function loadManifest(file) {
  const manifest = readManifest(file);
  const problems = manifestProblems(manifest);
  if (problems.length) throw new TypeError(`models manifest: ${problems.join('; ')}`);
  return manifest;
}

function modelNames(manifest = loadManifest()) {
  return Object.keys(manifest.models);
}

/** Models selected by name; throws on an unknown one. Default: all of them but the optional ones (`optional: true`, fetched by name only). */
function selectModels(manifest, names) {
  const known = Object.keys(manifest.models);
  if (names === undefined || names === null) return known.filter((name) => manifest.models[name].optional !== true);
  if (!Array.isArray(names) || !names.length) throw new TypeError('models: a non-empty list of model names expected.');
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length) throw new TypeError(`unknown model: ${unknown.join(', ')} (known: ${known.join(', ')})`);
  return [...new Set(names)];
}

/**
 * Every file of the selected models: where it lives under `dir`, where it comes
 * from, what it must weigh and hash to.
 */
function listFiles(manifest, names, dir) {
  const files = [];
  for (const name of selectModels(manifest, names)) {
    const model = manifest.models[name];
    for (const source of model.sources) {
      const base = source.dir || model.folder;
      for (const file of source.files) {
        const relative = `${base}/${file.path}`;
        files.push({
          model: name,
          repo: source.repo,
          revision: source.revision,
          path: file.path,
          relative,
          absolute: dir ? path.join(dir, ...relative.split('/')) : null,
          size: file.size,
          sha256: isMissingHash(file.sha256) ? null : file.sha256
        });
      }
    }
  }
  return files;
}

/** Files whose SHA-256 is still to be completed. */
function incompleteFiles(manifest, names) {
  return listFiles(manifest, names).filter((file) => file.sha256 === null);
}

module.exports = {
  MANIFEST_PATH,
  TO_COMPLETE,
  readManifest,
  loadManifest,
  manifestProblems,
  modelNames,
  selectModels,
  listFiles,
  incompleteFiles,
  isSafeRelativePath
};
