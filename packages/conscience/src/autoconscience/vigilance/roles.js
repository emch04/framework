'use strict';
/*
 * Multi-role reflection (proposition 14). Three separate reviews of a finding,
 * each a function injected by the application. This is not a vote and not a
 * panel of models: the code applies three fixed conditions to three
 * independent answers.
 *
 *   verifier         cites evidence INDEPENDENT of the finding's own evidence;
 *   contradictor     lists competing explanations with a strength in [0, 1];
 *                    none may be as strong as the finding's confidence;
 *   riskController   approves the scope the finding asks to be applied to.
 *
 * The finding moves forward ("supported") only if all three conditions hold.
 * Otherwise it stays a hypothesis. A role that fails, answers badly or is
 * missing blocks the finding (fail closed). Roles see only a frozen copy of the
 * finding, never each other's answers.
 */
const { fingerprintOf, deepFreeze, copy } = require('../../governor/util');
const { ready, invalid, actorOf, isNonEmptyString } = require('./common');

const SCOPES = Object.freeze(['observation', 'agent', 'domain', 'organisation']);
const ROLE_NAMES = Object.freeze(['verifier', 'contradictor', 'riskController']);
const EVIDENCE_KINDS = Object.freeze(['decision', 'prediction', 'outcome', 'correction', 'external']);

const fail = (role, code) => ({ role, passed: false, error: code, blockers: [`${role}_failed`] });

function judgeVerifier(result, finding, organisationId, ownRefs, minimumIndependent, verified) {
  const items = Array.isArray(result?.evidence) ? result.evidence : Array.isArray(result) ? result : null;
  if (!items) return fail('verifier', 'malformed_answer');
  const independent = [], dropped = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || !EVIDENCE_KINDS.includes(item.kind) || !isNonEmptyString(item.ref)) { dropped.push({ ref: item?.ref ?? null, reason: 'malformed' }); continue; }
    if (item.organisationId != null && item.organisationId !== organisationId) { dropped.push({ ref: item.ref, reason: 'cross_organisation' }); continue; }
    if (ownRefs.has(item.ref)) { dropped.push({ ref: item.ref, reason: 'not_independent' }); continue; }
    if (seen.has(`${item.kind}\u0000${item.ref}`)) continue;
    seen.add(`${item.kind}\u0000${item.ref}`);
    if (verified.get(`${item.kind}\u0000${item.ref}`) === false) { dropped.push({ ref: item.ref, reason: 'unverifiable' }); continue; }
    independent.push({ kind: item.kind, ref: item.ref });
  }
  const passed = independent.length >= minimumIndependent;
  return { role: 'verifier', passed, independentEvidence: independent, dropped, blockers: passed ? [] : ['no_independent_evidence'] };
}

function judgeContradictor(result, finding) {
  const list = Array.isArray(result?.competing) ? result.competing : Array.isArray(result) ? result : null;
  if (!list) return fail('contradictor', 'malformed_answer');
  const explanations = [];
  for (const item of list) {
    if (!item || !isNonEmptyString(item.statement) || typeof item.strength !== 'number' || !Number.isFinite(item.strength) || item.strength < 0 || item.strength > 1) return fail('contradictor', 'malformed_answer');
    explanations.push({ statement: item.statement, strength: item.strength });
  }
  const stronger = explanations.filter((e) => e.strength >= finding.confidence);
  return { role: 'contradictor', passed: stronger.length === 0, competing: explanations, stronger, blockers: stronger.length ? ['competing_explanation_as_strong'] : [] };
}

function judgeRisk(result, finding) {
  if (!result || typeof result.approved !== 'boolean' || !SCOPES.includes(result.maxScope)) return fail('riskController', 'malformed_answer');
  const blockers = [];
  if (!result.approved) blockers.push('risk_not_approved');
  else if (SCOPES.indexOf(result.maxScope) < SCOPES.indexOf(finding.requestedScope)) blockers.push('scope_too_broad');
  return { role: 'riskController', passed: blockers.length === 0, approved: result.approved, maxScope: result.maxScope, requestedScope: finding.requestedScope, blockers };
}

async function reviewByRoles(options = {}) {
  const { governor, organisationId, roles } = options;
  const org = await ready(governor, organisationId);
  const source = options.finding;
  if (!source || typeof source !== 'object' || !isNonEmptyString(source.id)) invalid('finding.id is required.');
  if (source.organisationId != null) governor.assertSingleOrganisation(org, source.organisationId);
  if (typeof source.confidence !== 'number' || !Number.isFinite(source.confidence) || source.confidence < 0 || source.confidence > 1) invalid('finding.confidence must be a number in [0, 1].');
  const requestedScope = source.requestedScope ?? 'agent';
  if (!SCOPES.includes(requestedScope)) invalid(`finding.requestedScope must be one of ${SCOPES.join(', ')}.`);
  if (!roles || ROLE_NAMES.some((name) => typeof roles[name] !== 'function')) invalid(`roles must provide the functions ${ROLE_NAMES.join(', ')}.`);
  if (new Set(ROLE_NAMES.map((name) => roles[name])).size !== ROLE_NAMES.length) invalid('The three roles must be three separate functions.');
  const minimumIndependent = options.minimumIndependent ?? 1;
  if (!Number.isInteger(minimumIndependent) || minimumIndependent < 1) invalid('minimumIndependent must be an integer >= 1.');
  if (options.evidenceExists != null && typeof options.evidenceExists !== 'function') invalid('evidenceExists must be a function.');

  const finding = { ...copy(source), organisationId: org, requestedScope };
  const ownRefs = new Set([finding.id, ...(finding.decisionIds ?? []), ...(finding.evidence ?? []).map((e) => e.ref)]);
  const answers = await Promise.allSettled(ROLE_NAMES.map(async (name) => {
    options.signal?.throwIfAborted();
    return roles[name](deepFreeze(copy(finding)), { organisationId: org, role: name, signal: options.signal });
  }));
  options.signal?.throwIfAborted();

  const answered = (name) => answers[ROLE_NAMES.indexOf(name)];
  const verifierAnswer = answered('verifier');
  const verified = new Map();
  if (verifierAnswer.status === 'fulfilled' && options.evidenceExists) {
    const items = Array.isArray(verifierAnswer.value?.evidence) ? verifierAnswer.value.evidence : Array.isArray(verifierAnswer.value) ? verifierAnswer.value : [];
    for (const item of items) {
      if (!item || !EVIDENCE_KINDS.includes(item.kind) || !isNonEmptyString(item.ref) || ownRefs.has(item.ref)) continue;
      let exists = false;
      try { exists = (await options.evidenceExists({ kind: item.kind, ref: item.ref, organisationId: org })) === true; } catch (_error) { exists = false; }
      verified.set(`${item.kind}\u0000${item.ref}`, exists);
    }
  }
  const reviews = {
    verifier: verifierAnswer.status === 'fulfilled' ? judgeVerifier(verifierAnswer.value, finding, org, ownRefs, minimumIndependent, verified) : fail('verifier', 'role_error'),
    contradictor: answered('contradictor').status === 'fulfilled' ? judgeContradictor(answered('contradictor').value, finding) : fail('contradictor', 'role_error'),
    riskController: answered('riskController').status === 'fulfilled' ? judgeRisk(answered('riskController').value, finding) : fail('riskController', 'role_error')
  };
  const blockers = ROLE_NAMES.flatMap((name) => reviews[name].blockers);
  const advances = blockers.length === 0;
  const result = {
    findingId: finding.id, organisationId: org, advances, status: advances ? 'supported' : 'hypothesis', blockers, reviews,
    finding: { ...finding, status: advances ? 'supported' : 'hypothesis' }, recorded: null
  };
  if (options.recordedBy) {
    result.recorded = await governor.recordFinding({
      organisationId: org, runId: options.runId ?? null, code: advances ? 'review_passed' : 'review_blocked', severity: advances ? 'info' : 'low',
      subject: { kind: 'finding', id: finding.id }, decisionIds: finding.decisionIds ?? [],
      evidenceRefs: reviews.verifier.independentEvidence?.map((e) => e.ref) ?? [], confidence: finding.confidence,
      metrics: { blockers: blockers.length, fingerprint: fingerprintOf({ id: finding.id, blockers }).slice(0, 16) }, recordedBy: actorOf(options.recordedBy)
    });
  }
  return result;
}

module.exports = { reviewByRoles, REVIEW_ROLES: ROLE_NAMES, REVIEW_SCOPES: SCOPES };
