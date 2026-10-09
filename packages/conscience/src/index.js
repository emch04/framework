'use strict';
/*
 * @astratra/conscience (P1): memory of an agent's decisions, outcomes,
 * corrections, lessons with evidence, and self-model, under a governor.
 */
const { createConscience, ERASURE_MODES } = require('./conscience');
const { createMemoryConscienceStore, matchesFilter } = require('./memoryStore');
const { postgresConscienceSchema, createPostgresConscienceStore } = require('./postgres');
const { frameStoredText, frameRecordsForModel } = require('./guard');
const { wordDelta } = require('./diff');
const { ConscienceError } = require('./errors');
const records = require('./records');
const { assertGovernorReady, isGovernor } = require('./governor/governor');
const { GovernorError } = require('./governor/util');

module.exports = {
  createConscience, createMemoryConscienceStore, createPostgresConscienceStore, postgresConscienceSchema,
  frameStoredText, frameRecordsForModel, wordDelta, matchesFilter,
  ConscienceError, GovernorError, assertGovernorReady, isGovernor,
  RECORD_KINDS: records.KINDS, OUTCOME_STATUSES: records.OUTCOME_STATUSES, CORRECTION_CLASSES: records.CORRECTION_CLASSES,
  LESSON_STATUSES: records.LESSON_STATUSES, EVIDENCE_DEGREES: records.EVIDENCE_DEGREES, EVIDENCE_KINDS: records.EVIDENCE_KINDS,
  PROVENANCE_KINDS: records.PROVENANCE_KINDS, ERASURE_MODES
};
