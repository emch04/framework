/** Entrée navigateur : client, éditeur et conversions, sans le serveur. */
const { createCollabProvider, createCollabEditor } = require('./client');
const { createConverter, defaultExtensions, DEFAULT_FIELD } = require('./convert');

module.exports = { createCollabProvider, createCollabEditor, createConverter, defaultExtensions, DEFAULT_FIELD };
