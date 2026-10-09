'use strict';
/*
 * @astratra/conscience/autoconscience: the reflective engine. In this version
 * it only declares its types (index.d.ts) and refuses to run: evaluation (P2),
 * experiments (P3), shadow mode (P4) and governed rollout (P5) come later.
 * Even the refusal checks the governor first, as every reflective entry will.
 */
const { assertGovernorReady } = require('../governor/governor');
const { ConscienceError } = require('../errors');

const AVAILABLE_FROM = 'P2';

async function runReflection(options = {}) {
  await assertGovernorReady(options.governor, { organisationId: options.organisationId });
  throw new ConscienceError('not_available', `runReflection is not available before phase ${AVAILABLE_FROM}: this version records decisions and evidence only.`);
}

module.exports = { runReflection, AVAILABLE_FROM };
