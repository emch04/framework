'use strict';
/* P3, second half: vigilance (17 drift, 18 follow-ups, 26 abstention, 27 night adversary, 14 multi-role review, 03 lesson turned into a test). */
const drift = require('./drift');
const followups = require('./followups');
const abstention = require('./abstention');
const adversary = require('./adversary');
const roles = require('./roles');
const lessonTests = require('./lessonTests');
const library = require('./library');
const store = require('./store');

module.exports = {
  detectDrift: drift.detectDrift, snapshotWindow: drift.snapshotWindow, populationStabilityIndex: drift.populationStabilityIndex,
  differenceInterval: drift.differenceInterval, DRIFT_RECOMMENDATIONS: drift.DRIFT_RECOMMENDATIONS,
  createFollowUps: followups.createFollowUps, followUpEraser: followups.followUpEraser, FOLLOW_UP_STATUSES: followups.FOLLOW_UP_STATUSES,
  abstentionPolicy: abstention.abstentionPolicy, shouldAbstain: abstention.shouldAbstain, ABSTENTION_DEFAULT_THRESHOLD: abstention.ABSTENTION_DEFAULT_THRESHOLD,
  generateAdversarialCases: adversary.generateAdversarialCases, ADVERSARIAL_CATEGORIES: adversary.ADVERSARIAL_CATEGORIES,
  reviewByRoles: roles.reviewByRoles, REVIEW_ROLES: roles.REVIEW_ROLES, REVIEW_SCOPES: roles.REVIEW_SCOPES,
  lessonToScenario: lessonTests.lessonToScenario,
  createScenarioLibrary: library.createScenarioLibrary, scenarioToTestkit: library.toScenario,
  SCENARIO_CATEGORIES: library.SCENARIO_CATEGORIES, CANDIDATE_STATUSES: library.CANDIDATE_STATUSES,
  createMemoryVigilanceStore: store.createMemoryVigilanceStore, createPostgresVigilanceStore: store.createPostgresVigilanceStore, postgresVigilanceSchema: store.postgresVigilanceSchema
};
