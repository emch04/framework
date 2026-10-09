'use strict';
/*
 * Progressive exposure of a candidate version (proposition 06). The hashing is
 * the one of @astratra/flags (FNV-1a over `seed NUL identifier`), copied here
 * so that this folder imports nothing: the same seed and the same identifier
 * give the same bucket in both. A real FlagProvider can be injected instead.
 */
const { GovernorError } = require('./util');

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(value), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function bucket(seed, identifier) {
  if (identifier === undefined || identifier === null || String(identifier) === '') return null;
  return fnv1a32(`${seed}\u0000${identifier}`) / 0x100000000;
}

const seedOf = (organisationId, kind, id, versionId) => `conscience:${organisationId}:${kind}:${id}:${versionId}`;
const flagKeyOf = (organisationId, kind, id) => `conscience.${organisationId}.${kind}.${id}`;

function normalizeExposure(input = {}, previous = null) {
  const percentage = input.percentage === undefined ? (previous?.percentage ?? 0) : input.percentage;
  if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new GovernorError('invalid_rollout', 'percentage must be a number from 0 to 100.');
  }
  const cohorts = input.cohorts === undefined ? (previous?.cohorts ?? []) : input.cohorts;
  if (!Array.isArray(cohorts) || !cohorts.every((c) => typeof c === 'string' && c.trim())) throw new GovernorError('invalid_rollout', 'cohorts must be an array of names.');
  return { percentage, cohorts: [...new Set(cohorts)] };
}

/**
 * Does this caller get the candidate? Cohorts say who is eligible (when listed),
 * the percentage says which share of the eligible. No identity and no cohort
 * means the stable version.
 */
function servesCandidate(exposure, seed, context = {}) {
  if (!exposure || exposure.percentage <= 0) return false;
  const attributes = context.attributes ?? {};
  if (exposure.cohorts.length) {
    const own = Array.isArray(attributes.cohorts) ? attributes.cohorts : [attributes.cohort];
    if (!own.some((name) => exposure.cohorts.includes(name))) return false;
  }
  if (exposure.percentage >= 100) return true;
  const fraction = bucket(seed, context.targetingKey);
  return fraction !== null && fraction < exposure.percentage / 100;
}

/** Rules in the shape of @astratra/flags (createMemorySource), one boolean flag per object that has a candidate. */
function toFlagRules(objects) {
  const flags = {};
  for (const object of objects) {
    if (!object.candidate || !object.rollout) continue;
    const flag = { type: 'boolean', default: false, value: true, rollout: object.rollout.percentage, seed: seedOf(object.organisationId, object.kind, object.id, object.candidate) };
    if (object.rollout.cohorts.length) flag.target = { cohort: object.rollout.cohorts };
    flags[flagKeyOf(object.organisationId, object.kind, object.id)] = flag;
  }
  return { flags };
}

module.exports = { fnv1a32, bucket, seedOf, flagKeyOf, normalizeExposure, servesCandidate, toFlagRules };
