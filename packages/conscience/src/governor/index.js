'use strict';
/*
 * @astratra/conscience/governor: the deterministic governor. Imports Node
 * built-ins and the files of this folder only (checked by a test).
 */
const { createGovernor, assertGovernorReady, isGovernor, STATUSES, REASONS } = require('./governor');
const { PROTECTED_SCOPES, MODIFIABLE_KINDS, AUTOMATIC_CHANGES, DEFAULT_CONSTITUTION, validatePolicy, scopesOf, protectedRulesTouched } = require('./policy');
const { createMemoryGovernorStore } = require('./stores');
const { postgresGovernorSchema, createPostgresGovernorStore } = require('./postgres');
const { GovernorError } = require('./util');
const { RISK_LEVELS, DECLINE_REASONS } = require('./approvals');
const { SEVERITIES, REPORT_SCHEMA } = require('./review');
const { bucket } = require('./rollout');
const { createRemoteSettings, parseRemoteSettings, remotePolicy, REMOTE_SETTINGS_SCHEMA, DECISION_RESULTS } = require('./remote');

module.exports = {
  createGovernor, assertGovernorReady, isGovernor, validatePolicy, scopesOf, protectedRulesTouched,
  createMemoryGovernorStore, createPostgresGovernorStore, postgresGovernorSchema, GovernorError,
  PROPOSAL_STATUSES: STATUSES, REASONS, PROTECTED_SCOPES, MODIFIABLE_KINDS, AUTOMATIC_CHANGES, DEFAULT_CONSTITUTION,
  RISK_LEVELS, DECLINE_REASONS, FINDING_SEVERITIES: SEVERITIES, MORNING_REPORT_SCHEMA: REPORT_SCHEMA, rolloutBucket: bucket,
  createRemoteSettings, parseRemoteSettings, remotePolicy, REMOTE_SETTINGS_SCHEMA, DECISION_RESULTS
};
