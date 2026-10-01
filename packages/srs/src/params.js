'use strict';

const { generatorParameters } = require('ts-fsrs');

/** FSRS-4.5, FSRS-5 et FSRS-6 : 17, 19 ou 21 poids. */
const WEIGHT_LENGTHS = [17, 19, 21];

/**
 * Paramètres FSRS : rétention visée, intervalle maximal, pas d'apprentissage,
 * brouillage, poids du modèle. Les valeurs par défaut sont celles de ts-fsrs.
 * Une valeur incohérente (rétention hors ]0,1], poids de mauvaise longueur) est
 * refusée ici plutôt que de produire des échéances absurdes plus tard.
 */
function createSrsParams(overrides = {}) {
  // ts-fsrs corrige en silence les valeurs hors limites : on contrôle donc avant lui.
  const { request_retention: retention, maximum_interval: maximum, w } = overrides;
  if (retention !== undefined && !(retention > 0 && retention <= 1)) throw new RangeError('INVALID_REQUEST_RETENTION');
  if (maximum !== undefined && !(maximum >= 1)) throw new RangeError('INVALID_MAXIMUM_INTERVAL');
  if (w !== undefined && (!WEIGHT_LENGTHS.includes(w.length) || !w.every(Number.isFinite))) {
    throw new RangeError('INVALID_FSRS_WEIGHTS');
  }
  return generatorParameters(overrides);
}

module.exports = { createSrsParams };
