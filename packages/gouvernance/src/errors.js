'use strict';

/** Erreur du pack : `code` est stable (à tester), le message ne l'est pas. */
class GouvernanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GouvernanceError';
    this.code = code;
  }
}

module.exports = { GouvernanceError };
