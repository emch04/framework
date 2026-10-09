/**
 * Startup check for applications: are the models they depend on on disk, and
 * are they the ones pinned in the manifest?
 *
 * In production a missing or altered model is an error that stops the start —
 * a protection that silently does nothing is worse than no protection. Outside
 * production the report is returned and nothing throws, so a laptop without the
 * weights still runs (the clients degrade as they always do).
 */
const { checkModels } = require('./fetcher');
const { loadManifest, selectModels } = require('./manifest');

class ModelsNotReadyError extends Error {
  constructor(problems) {
    const first = problems[0];
    const where = first.path ? ` (file ${first.path})` : '';
    super(`model "${first.model}" is ${first.status === 'missing' ? 'missing' : 'altered'}${where}`
      + `${problems.length > 1 ? `, and ${problems.length - 1} more problem(s)` : ''}: run astratra-models fetch`);
    this.name = 'ModelsNotReadyError';
    this.code = 'MODELS_NOT_READY';
    this.problems = problems;
  }
}

/**
 * @param {object} options
 * @param {string[]} options.required  model names that must be ready (e.g. ['injection', 'moderation']).
 * @param {string} [options.dir]       models directory. Default: MODELS_DIR.
 * @param {boolean} [options.production] default: NODE_ENV === 'production'.
 * @param {boolean} [options.strict]   throw outside production too.
 * @param {'sha256'|'size'} [options.verify] default 'sha256' (re-hashes the files: ~1 s per GB).
 * @param {object} [options.manifest]  default: the packaged manifest.
 * @param {object} [options.env]       default: process.env.
 * @returns {{ ok: boolean, production: boolean, problems: Array<{ model: string, status: string, path?: string }> }}
 */
function assertModelsReady(options = {}) {
  const env = options.env || process.env;
  const { required } = options;
  if (!Array.isArray(required) || !required.length) throw new TypeError('required: a non-empty list of model names expected.');
  const manifest = options.manifest || loadManifest();
  const names = selectModels(manifest, required);
  const production = options.production === undefined ? env.NODE_ENV === 'production' : Boolean(options.production);
  const dir = options.dir || env.MODELS_DIR;
  const enforce = production || Boolean(options.strict);

  if (!dir) {
    const problems = names.map((model) => ({ model, status: 'missing' }));
    if (enforce) throw new ModelsNotReadyError(problems);
    return { ok: false, production, problems };
  }
  const report = checkModels({ dir, models: names, manifest, verify: options.verify });
  const problems = [];
  for (const [model, state] of Object.entries(report.models)) {
    if (state.status === 'ok') continue;
    const bad = state.files.find((file) => file.status !== 'ok');
    problems.push({ model, status: state.status, path: bad && bad.path });
  }
  if (problems.length && enforce) throw new ModelsNotReadyError(problems);
  return { ok: problems.length === 0, production, problems };
}

module.exports = { assertModelsReady, ModelsNotReadyError };
