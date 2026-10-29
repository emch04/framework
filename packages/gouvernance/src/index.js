'use strict';
/*
 * @astratra/gouvernance : une IA propose une action sur les données ; le pack calcule l'aperçu
 * exact, applique les niveaux d'autonomie, vérifie la validation humaine signée, revérifie les
 * données au moment d'écrire et exécute tout ou rien, avec un journal d'audit complet.
 * S'appuie sur @astratra/conscience (gouverneur : arrêt d'urgence, journal, quotas).
 */
const { createDataGovernance, STATUSES } = require('./governance');
const { defineResources, OPERATIONS, COMPARISONS, MAX_ACTIONS, PROPOSAL_SCHEMA, VALIDATION_SCHEMA, CHALLENGE_SCHEMA, RESULT_SCHEMA } = require('./contract');
const { LEVELS, DEFAULT_LEVEL, normalizeRules, decideLevel } = require('./levels');
const { DECISIONS, challengeFor, signValidation, verifyValidation, createTrust } = require('./validation');
const { stableStringify, digestOf } = require('./stable');
const { createMemoryGovernanceStore, createMemoryConnector } = require('./memory');
const { GouvernanceError } = require('./errors');
const { trustSuggestions, trustEntriesFromRecords, outcomeOfRecord, TRUST_OUTCOMES } = require('./trust');

module.exports = {
  createDataGovernance, createMemoryGovernanceStore, createMemoryConnector, defineResources,
  normalizeRules, decideLevel, challengeFor, signValidation, verifyValidation, createTrust,
  stableStringify, digestOf, GouvernanceError, trustSuggestions, trustEntriesFromRecords, outcomeOfRecord, TRUST_OUTCOMES,
  STATUSES, LEVELS, DEFAULT_LEVEL, OPERATIONS, COMPARISONS, MAX_ACTIONS, DECISIONS,
  PROPOSAL_SCHEMA, VALIDATION_SCHEMA, CHALLENGE_SCHEMA, RESULT_SCHEMA
};
