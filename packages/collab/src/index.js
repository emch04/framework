/**
 * @astratra/collab — édition collaborative en temps réel.
 *
 * Point d'entrée complet (Node). Dans un navigateur, importe plutôt
 * `@astratra/collab/client`, qui n'embarque pas le serveur.
 */

const { createCollabServer } = require('./server');
const { createCollabProvider, createCollabEditor } = require('./client');
const { createConverter, defaultExtensions, DEFAULT_FIELD } = require('./convert');
const {
  assertPersistence,
  createMemoryPersistence,
  createPostgresPersistence,
  createMongoPersistence
} = require('./persistence');

module.exports = {
  createCollabServer,
  createCollabProvider,
  createCollabEditor,
  createConverter,
  defaultExtensions,
  DEFAULT_FIELD,
  assertPersistence,
  createMemoryPersistence,
  createPostgresPersistence,
  createMongoPersistence
};
