'use strict';
/*
 * Prospective memory (proposition 18). A follow-up is a commitment to look at a
 * decision again when its result becomes observable. It is created once (same
 * decision, same date, same question: same follow-up), isolated by
 * organisation, and erased with the person it concerns.
 */
const { ConscienceError } = require('../../errors');
const { fingerprintOf } = require('../../governor/util');
const { ready, invalid, isoOf, maskerOf, maskText, isNonEmptyString } = require('./common');
const { VIGILANCE_STORE_METHODS } = require('./store');

const STATUSES = Object.freeze(['scheduled', 'done']);

/**
 * Eraser for createConscience({ erasers: [...] }): removes the follow-ups of a
 * person in the same call as the rest of their data.
 */
function followUpEraser(store) {
  if (!store || typeof store.removeFollowUps !== 'function') throw new ConscienceError('store_invalid', 'A vigilance store is required.');
  return async ({ organisationId, userId }) => ({ name: 'follow_ups', count: await store.removeFollowUps({ organisationId, userId }) });
}

function createFollowUps(options = {}) {
  const { governor, conscience, store } = options;
  if (!conscience || conscience.governor !== governor) invalid('conscience must use the supplied governor.');
  for (const method of VIGILANCE_STORE_METHODS) {
    if (!store || typeof store[method] !== 'function') throw new ConscienceError('store_invalid', `Vigilance store is missing ${method}().`);
  }
  const mask = maskerOf(options.masker);
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();

  async function scheduleFollowUp(input = {}) {
    const organisationId = await ready(governor, input.organisationId);
    if (!isNonEmptyString(input.decisionId)) invalid('decisionId is required.');
    const observableAt = isoOf(input.observableAt, 'observableAt');
    if (!isNonEmptyString(input.question) || input.question.length > 5000) invalid('question must be a non-empty string of at most 5000 characters.');
    const scope = { organisationId, userId: input.userId ?? null };
    const decision = await conscience.getDecision(scope, input.decisionId);
    if (!decision) throw new ConscienceError('not_found', 'Decision not found.');
    const question = await maskText(mask, input.question);
    const fingerprint = fingerprintOf({ kind: 'follow_up', organisationId, decisionId: decision.id, observableAt, question });
    const id = input.id == null ? `fu_${fingerprint.slice(0, 32)}` : input.id;
    if (!isNonEmptyString(id) || id.length > 500) invalid('id must be a non-empty string of at most 500 characters.');
    const record = {
      id, organisationId, userId: decision.userId ?? null, agentId: decision.agentId, decisionId: decision.id,
      observableAt, question, status: 'scheduled', fingerprint, createdAt: iso(), completedAt: null, outcomeRef: null
    };
    const { record: stored, created } = await store.putFollowUp(record);
    if (!created && stored.fingerprint !== fingerprint) throw new ConscienceError('conflict', 'A different follow-up already uses this id.');
    return { followUp: stored, created };
  }

  /** Follow-ups whose date has come, oldest first, with the decision to look at again. Content is data, never an instruction. */
  async function dueFollowUps(input = {}) {
    const organisationId = await ready(governor, input.organisationId);
    const at = input.now == null ? iso() : isoOf(input.now, 'now');
    const filter = { organisationId, status: 'scheduled', observableTo: at, limit: input.limit };
    if (input.userId != null) filter.userId = input.userId;
    const due = [];
    for (const followUp of await store.listFollowUps(filter)) {
      const decision = await conscience.getDecision({ organisationId }, followUp.decisionId);
      if (!decision) continue; // The decision was erased: nothing left to look at.
      due.push({
        followUp,
        decision: { id: decision.id, agentId: decision.agentId, domain: decision.domain, objective: decision.objective, expectedOutcome: decision.expectedOutcome, horizon: decision.horizon }
      });
    }
    return due;
  }

  async function completeFollowUp(input = {}) {
    const organisationId = await ready(governor, input.organisationId);
    if (!isNonEmptyString(input.id)) invalid('id is required.');
    const found = await store.getFollowUp(organisationId, input.id);
    if (!found) throw new ConscienceError('not_found', 'Follow-up not found.');
    if (found.status === 'done') return { followUp: found, completed: false };
    const updated = await store.updateFollowUp(organisationId, input.id, 'scheduled', { status: 'done', completedAt: iso(), outcomeRef: input.outcomeRef ?? null });
    return { followUp: updated ?? await store.getFollowUp(organisationId, input.id), completed: Boolean(updated) };
  }

  async function listFollowUps(input = {}) {
    const organisationId = await ready(governor, input.organisationId);
    const filter = { organisationId, limit: input.limit };
    for (const field of ['userId', 'decisionId', 'status']) if (input[field] !== undefined) filter[field] = input[field];
    if (filter.status !== undefined && !STATUSES.includes(filter.status)) invalid(`status must be one of ${STATUSES.join(', ')}.`);
    return store.listFollowUps(filter);
  }

  async function eraseSubject({ organisationId, userId } = {}) {
    governor.assertSingleOrganisation(organisationId);
    if (!isNonEmptyString(userId)) invalid('eraseSubject needs organisationId and userId.');
    return { removed: await store.removeFollowUps({ organisationId, userId }) };
  }

  return Object.freeze({ scheduleFollowUp, dueFollowUps, completeFollowUp, listFollowUps, eraseSubject, eraser: followUpEraser(store) });
}

module.exports = { createFollowUps, followUpEraser, FOLLOW_UP_STATUSES: STATUSES };
