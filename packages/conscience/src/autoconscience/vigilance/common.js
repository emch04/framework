'use strict';
/*
 * Helpers shared by the vigilance modules (P3, second half). Deterministic:
 * no language model, no network, no clock of its own.
 */
const { ConscienceError } = require('../../errors');
const { assertGovernorReady } = require('../../governor/governor');
const { isNonEmptyString, copy } = require('../../governor/util');

const invalid = (message) => { throw new ConscienceError('invalid_input', message); };

/** Same accepted shapes as createConscience: a function, a redactor with redactString(), or an object with mask(). */
function maskerOf(masker) {
  if (typeof masker === 'function') return masker;
  if (masker && typeof masker.redactString === 'function') return (text) => masker.redactString(text);
  if (masker && typeof masker.mask === 'function') return (text) => masker.mask(text);
  throw new ConscienceError('masker_required', 'A masker is required: a function (text) => masked text, a redactor of @astratra/privacy, or an object with mask(text).');
}

async function maskText(mask, value) {
  if (value == null) return value;
  const masked = await mask(String(value));
  if (typeof masked !== 'string') throw new ConscienceError('masker_invalid', 'The masker must return a string.');
  return masked;
}

async function maskDeep(mask, value, depth = 0) {
  if (typeof value === 'string') return maskText(mask, value);
  if (depth > 32 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Promise.all(value.map((item) => maskDeep(mask, item, depth + 1)));
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = await maskDeep(mask, child, depth + 1);
  return out;
}

/** Governor present, genuine and not halted; exactly one organisation. Returns the organisation. */
async function ready(governor, organisationId) {
  await assertGovernorReady(governor, { organisationId });
  return governor.assertSingleOrganisation(organisationId);
}

function actorOf(actor, fallback) {
  const who = actor ?? fallback;
  if (!who || typeof who !== 'object' || !isNonEmptyString(who.kind) || !isNonEmptyString(who.id)) invalid('An actor { kind, id } is required.');
  return { kind: who.kind, id: who.id };
}

const isoOf = (value, field) => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (value == null || Number.isNaN(parsed.getTime())) invalid(`${field} must be a valid date.`);
  return parsed.toISOString();
};

const plain = (value) => copy(value);

module.exports = { invalid, maskerOf, maskText, maskDeep, ready, actorOf, isoOf, plain, isNonEmptyString };
