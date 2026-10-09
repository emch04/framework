const client = require('./client');
const { createEndpointBreaker, ModelsCircuitOpenError } = require('./breaker');
const deploy = require('./deploy');
const pricing = require('./pricing');
const manifest = require('./manifest');
const fetcher = require('./fetcher');
const ready = require('./ready');

module.exports = {
  ...client,
  createEndpointBreaker,
  ModelsCircuitOpenError,
  ...deploy,
  ...pricing,
  loadManifest: manifest.loadManifest,
  manifestProblems: manifest.manifestProblems,
  listModelFiles: manifest.listFiles,
  MANIFEST_PATH: manifest.MANIFEST_PATH,
  fetchModels: fetcher.fetchModels,
  checkModels: fetcher.checkModels,
  ManifestIncompleteError: fetcher.ManifestIncompleteError,
  ChecksumError: fetcher.ChecksumError,
  assertModelsReady: ready.assertModelsReady,
  ModelsNotReadyError: ready.ModelsNotReadyError
};
