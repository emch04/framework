'use strict';
/*
 * Which strategy may run in the shadow? Only one that humans already approved:
 * a governor object version in the "candidate" state (it was staged from an
 * approved proposal), or a proposal in the "approved" state with human
 * approvals. A pending, declined, rejected or expired proposal is refused, and
 * so is a stable or discarded version. Re-checked before every run.
 */
const { ConscienceError } = require('../../errors');
const { fingerprintOf } = require('../../governor/util');
const { isNonEmptyString } = require('../vigilance/common');

const refuse = (code, message) => { throw new ConscienceError(code, message); };

function approvedByHumans(proposal) {
  return proposal.status === 'approved' && Array.isArray(proposal.approvals) && proposal.approvals.length > 0
    && proposal.approvals.every((a) => a?.approver?.kind === 'human' && isNonEmptyString(a.approver.id));
}

async function approvedProposal(governor, organisationId, proposalId) {
  const proposal = await governor.getProposal(organisationId, proposalId);
  if (!proposal) refuse('not_found', 'Proposal not found.');
  if (proposal.organisationId !== organisationId) refuse('cross_organisation', 'The proposal belongs to another organisation.');
  if (!approvedByHumans(proposal)) {
    refuse('candidate_not_approved', `Proposal is ${proposal.status}: only a proposal approved by humans may run in the shadow.`);
  }
  return proposal;
}

/**
 * @param reference `{ proposalId }` or `{ kind, id, versionId? }`
 * @returns the verified description of the candidate strategy (data only)
 */
async function resolveCandidate(governor, organisationId, reference) {
  if (!reference || typeof reference !== 'object') refuse('invalid_input', 'candidate must name a governor object version or an approved proposal.');
  const byProposal = reference.proposalId != null, byVersion = reference.kind != null || reference.id != null;
  if (byProposal === byVersion) refuse('invalid_input', 'candidate: give either { proposalId } or { kind, id }.');
  if (byProposal) {
    if (!isNonEmptyString(reference.proposalId)) refuse('invalid_input', 'proposalId must be a non-empty string.');
    const proposal = await approvedProposal(governor, organisationId, reference.proposalId);
    const content = proposal.change;
    return { source: 'proposal', kind: proposal.target.kind, id: proposal.target.id, versionId: null, proposalId: proposal.id, content,
      fingerprint: fingerprintOf({ proposalId: proposal.id, proposal: proposal.fingerprint, content }) };
  }
  if (!isNonEmptyString(reference.kind) || !isNonEmptyString(reference.id)) refuse('invalid_input', 'candidate needs kind and id.');
  const at = { organisationId, kind: reference.kind, id: reference.id };
  const object = await governor.getObject(at);
  if (!object) refuse('not_found', 'Object not registered.');
  if (!object.candidate) refuse('candidate_not_staged', 'This object has no candidate version: only a candidate may run in the shadow.');
  if (reference.versionId != null && reference.versionId !== object.candidate) refuse('candidate_not_staged', 'That version is not the candidate of this object.');
  const version = (await governor.listVersions(at)).find((v) => v.versionId === object.candidate);
  if (!version || version.status !== 'candidate') refuse('candidate_not_staged', 'The candidate version cannot be read.');
  if (version.source !== 'proposal' || !isNonEmptyString(version.proposalId)) refuse('candidate_not_approved', 'A candidate version must come from an approved proposal.');
  // The governor staged it from an approved proposal; check again that the approval is still a human one.
  await approvedProposalOrExpired(governor, organisationId, version.proposalId);
  return { source: 'version', kind: at.kind, id: at.id, versionId: version.versionId, proposalId: version.proposalId, content: version.content,
    fingerprint: fingerprintOf({ kind: at.kind, id: at.id, versionId: version.versionId, version: version.fingerprint }) };
}

/* A staged proposal keeps the "approved" status; only a lapsed approval changes it. A lapsed approval does not undo a staged candidate. */
async function approvedProposalOrExpired(governor, organisationId, proposalId) {
  const proposal = await governor.getProposal(organisationId, proposalId);
  if (!proposal) refuse('not_found', 'Proposal not found.');
  const humans = Array.isArray(proposal.approvals) && proposal.approvals.length > 0 && proposal.approvals.every((a) => a?.approver?.kind === 'human');
  if (!['approved', 'expired'].includes(proposal.status) || !humans) refuse('candidate_not_approved', `The proposal behind this candidate is ${proposal.status}.`);
  return proposal;
}

module.exports = { resolveCandidate };
