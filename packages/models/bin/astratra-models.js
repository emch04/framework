#!/usr/bin/env node
/**
 * astratra-models — download and verify the models of the local model service.
 *
 *   astratra-models fetch [--models a,b] [--dir DIR] [--check] [--json]
 *   astratra-models list  [--dir DIR]
 *
 * fetch    downloads the files pinned in the manifest (Hugging Face, fixed
 *          commit), verifies every SHA-256 and deletes any file that differs.
 *          Interrupted downloads resume. --check downloads nothing: it verifies
 *          what is present, offline.
 * list     the models of the manifest, their licence and size, and what is
 *          present under DIR when given.
 *
 * DIR defaults to $MODELS_DIR. Exit codes: 0 done, 1 a model is missing,
 * altered or could not be downloaded, 2 usage, 3 manifest incomplete.
 */
const { fetchModels, checkModels, ManifestIncompleteError } = require('../src/fetcher');
const { loadManifest, listFiles } = require('../src/manifest');

const USAGE = `usage:
  astratra-models fetch [--models a,b] [--dir DIR] [--check] [--json]
  astratra-models list [--dir DIR]

DIR defaults to $MODELS_DIR. --check verifies without the network.`;

function parse(argv) {
  const options = { command: argv[0], models: undefined, dir: process.env.MODELS_DIR, check: false, json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--models' || arg === '--dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new TypeError(`${arg} needs a value`);
      i += 1;
      if (arg === '--dir') options.dir = value;
      else options.models = value.split(',').map((name) => name.trim()).filter(Boolean);
    } else throw new TypeError(`unknown option: ${arg}`);
  }
  return options;
}

const megabytes = (bytes) => (bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`);

async function main(argv, out = process.stdout, err = process.stderr) {
  const write = (text) => out.write(`${text}\n`);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    write(USAGE);
    return argv.length ? 0 : 2;
  }
  let options;
  try {
    options = parse(argv);
    if (options.command !== 'fetch' && options.command !== 'list') throw new TypeError(`unknown command: ${options.command}`);
  } catch (error) {
    err.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  const manifest = loadManifest();
  try {
    if (options.command === 'list') {
      for (const [name, model] of Object.entries(manifest.models)) {
        const files = listFiles(manifest, [name], options.dir);
        const total = files.reduce((sum, file) => sum + file.size, 0);
        const state = options.dir ? ` [${checkModels({ dir: options.dir, models: [name], manifest, verify: 'size' }).models[name].status}]` : '';
        write(`${name.padEnd(11)} ${megabytes(total).padStart(8)}  ${model.license}  ${model.sources.map((s) => `${s.repo}@${s.revision.slice(0, 8)}`).join(' + ')}${state}`);
      }
      return 0;
    }
    if (!options.dir) {
      err.write('a models directory is required: --dir DIR or $MODELS_DIR\n');
      return 2;
    }
    if (options.check) {
      const report = checkModels({ dir: options.dir, models: options.models, manifest });
      if (options.json) write(JSON.stringify(report));
      else {
        for (const [name, state] of Object.entries(report.models)) {
          write(`${state.status === 'ok' ? 'ok     ' : state.status.padEnd(7)} ${name}`);
          for (const file of state.files.filter((f) => f.status !== 'ok')) write(`        ${file.status}: ${file.path}`);
        }
      }
      return report.ok ? 0 : 1;
    }
    const names = options.models;
    const files = listFiles(manifest, names, options.dir);
    err.write(`fetching ${new Set(files.map((f) => f.model)).size} model(s), up to ${megabytes(files.reduce((s, f) => s + f.size, 0))}, into ${options.dir}\n`);
    await fetchModels({
      dir: options.dir,
      models: names,
      manifest,
      onEvent: (event) => {
        if (options.json) return;
        if (event.type === 'download') err.write(`  downloading ${event.path} (${megabytes(event.size)}${event.resumedAt ? `, resuming at ${megabytes(event.resumedAt)}` : ''})\n`);
        else if (event.type === 'verified') err.write(`  verified    ${event.path}\n`);
        else if (event.type === 'present') err.write(`  present     ${event.path}\n`);
        else if (event.type === 'retry') err.write(`  retry ${event.attempt}: ${event.path} (${event.message})\n`);
      }
    });
    const report = checkModels({ dir: options.dir, models: names, manifest });
    if (options.json) write(JSON.stringify(report));
    else write(report.ok ? 'all models present and verified' : 'verification failed after download');
    return report.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof ManifestIncompleteError) {
      err.write(`${error.message}\nComplete the SHA-256 fields of data/models-manifest.json (scripts/build-manifest.js) and try again.\n`);
      return 3;
    }
    if (error instanceof TypeError) {
      err.write(`${error.message}\n`);
      return 2;
    }
    err.write(`${error.message}\n`);
    return 1;
  }
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
