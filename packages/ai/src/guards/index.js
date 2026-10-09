'use strict';
const { createGuards, DECISIONS, FAIL_CLOSED, FAIL_OPEN } = require('./createGuards');
const { frameUntrusted, NOTICE } = require('./frame');
const { findPersonalData } = require('./leaks');
const { recommendedGuards } = require('./recommended');

module.exports = {
  createGuards,
  recommendedGuards,
  frameUntrusted,
  UNTRUSTED_NOTICE: NOTICE,
  findPersonalData,
  GUARD_DECISIONS: DECISIONS,
  FAIL_CLOSED,
  FAIL_OPEN
};
