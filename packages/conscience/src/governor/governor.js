'use strict';
const crypto = require('node:crypto');
const { GovernorError, fingerprintOf, copy, isNonEmptyString } = require('./util');
const { validatePolicy, protectedRulesTouched } = require('./policy');
const { createMemoryGovernorStore } = require('./stores');

const STATUSES = Object.freeze(['rejected', 'pending_approval', 'approved', 'declined']);
const PROPOSER_KINDS = Object.freeze(['engine', 'model', 'human', 'system']);
const REASONS = Object.freeze({
  HALTED: 'governor_halted',
  INVALID: 'invalid_proposal',
  CROSS_ORGANISATION: 'cross_organisation',
  PROTECTED: 'protected_scope',
  NOT_ALLOWLISTED: 'not_allowlisted',
  HUMAN_APPROVAL: 'human_approval_required',
  BUDGET: 'budget_exceeded'
});
const GLOBAL = '*';

/* Governors built by createGovernor. A look-alike object never passes the bootstrap check. */
const genuine = new WeakSet();

const actorOf = (actor) => (actor && typeof actor === 'object' ? { kind: String(actor.kind ?? ''), id: String(actor.id ?? '') } : null);

/**
 * Deterministic governor: constitution, permissions, spending, isolation,
 * kill switch, human approvals and an audit journal. No model is consulted;
 * the same policy and the same proposal always give the same decision.
 */
function createGovernor(policy, options = {}) {
  const rules = validatePolicy(policy);
  const store = options.store ?? createMemoryGovernorStore();
  for (const method of ['putProposal', 'getProposal', 'transitionProposal', 'listProposals', 'appendAudit', 'listAudit', 'reserveSpend', 'getControl', 'setControl']) {
    if (typeof store[method] !== 'function') throw new GovernorError('governor_unavailable', `Governor store is missing ${method}().`);
  }
  const now = options.now ?? Date.now;
  const newId = options.idFactory ?? (() => crypto.randomUUID());
  const iso = () => new Date(now()).toISOString();

  async function audit(entry) {
    const full = { id: newId(), at: iso(), policyVersion: rules.version, organisationId: null, proposalId: null, reasons: [], actor: null, ...entry };
    await store.appendAudit(full);
    try { await options.onEvent?.({ type: 'governor', ...copy(full) }); } catch (_error) { /* Observers never change a decision. */ }
    return full;
  }

  async function haltState(organisationId) {
    if (rules.halted) return { halted: true, scope: GLOBAL, reason: 'policy' };
    const global = await store.getControl(`halt:${GLOBAL}`);
    if (global?.halted) return { halted: true, scope: GLOBAL, reason: global.reason ?? null };
    if (organisationId != null) {
      const local = await store.getControl(`halt:${organisationId}`);
      if (local?.halted) return { halted: true, scope: organisationId, reason: local.reason ?? null };
    }
    return { halted: false };
  }

  function assertSingleOrganisation(...ids) {
    const list = ids.flat().filter((id) => id !== undefined && id !== null);
    if (!list.length || !list.every(isNonEmptyString)) throw new GovernorError('organisation_required', 'An operation needs exactly one organisation.');
    if (new Set(list).size !== 1) throw new GovernorError(REASONS.CROSS_ORGANISATION, 'An operation may touch only one organisation.');
    return list[0];
  }

  function normalizeProposal(input) {
    if (!input || typeof input !== 'object') throw new GovernorError(REASONS.INVALID, 'A proposal must be an object.');
    if (!isNonEmptyString(input.organisationId)) throw new GovernorError('organisation_required', 'A proposal needs its organisationId.');
    const target = input.target && typeof input.target === 'object'
      ? { kind: input.target.kind ?? null, id: input.target.id ?? null, version: input.target.version ?? null, organisationId: input.target.organisationId ?? null }
      : null;
    const content = {
      organisationId: input.organisationId, target, change: input.change === undefined ? null : copy(input.change),
      justification: input.justification ?? null, scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
      organisationIds: Array.isArray(input.organisationIds) ? input.organisationIds.map(String) : [],
      proposedBy: actorOf(input.proposedBy), owner: input.owner ?? null, tests: copy(input.tests) ?? null,
      replay: copy(input.replay) ?? null, rollback: copy(input.rollback) ?? null
    };
    const fingerprint = fingerprintOf(content);
    return { id: isNonEmptyString(input.id) ? input.id : `proposal_${fingerprint.slice(0, 32)}`, ...content, fingerprint };
  }

  function judge(proposal, halted) {
    const reasons = [];
    let touched = [];
    if (halted) reasons.push(REASONS.HALTED);
    const target = proposal.target;
    if (!target || !isNonEmptyString(target.kind) || !isNonEmptyString(target.id) || proposal.change === null
      || !proposal.proposedBy || !PROPOSER_KINDS.includes(proposal.proposedBy.kind) || !proposal.proposedBy.id) reasons.push(REASONS.INVALID);
    const orgs = new Set([proposal.organisationId, ...proposal.organisationIds, ...(target?.organisationId ? [target.organisationId] : [])]);
    if (orgs.size > 1) reasons.push(REASONS.CROSS_ORGANISATION);
    touched = protectedRulesTouched(rules, proposal);
    if (touched.length) reasons.push(REASONS.PROTECTED);
    if (target && !rules.permissions.modifiable.includes(target.kind)) reasons.push(REASONS.NOT_ALLOWLISTED);
    if (reasons.length) return { status: 'rejected', reasons, rules: touched };
    return { status: 'pending_approval', reasons: [REASONS.HUMAN_APPROVAL], rules: [] };
  }

  async function evaluatePolicy(input) {
    const proposal = normalizeProposal(input);
    const existing = await store.getProposal(proposal.organisationId, proposal.id);
    if (existing) {
      if (existing.fingerprint !== proposal.fingerprint) throw new GovernorError('proposal_conflict', 'A different proposal already uses this id.');
      return existing;
    }
    const halted = (await haltState(proposal.organisationId)).halted;
    const verdict = judge(proposal, halted);
    const at = iso();
    const record = { ...proposal, ...verdict, policyVersion: rules.version, createdAt: at, decidedAt: verdict.status === 'rejected' ? at : null, approver: null, note: null };
    const { record: stored, created } = await store.putProposal(record);
    if (!created) {
      if (stored.fingerprint !== proposal.fingerprint) throw new GovernorError('proposal_conflict', 'A different proposal already uses this id.');
      return stored;
    }
    await audit({ action: 'evaluate', organisationId: record.organisationId, proposalId: record.id, decision: record.status, reasons: record.reasons, rules: record.rules, actor: record.proposedBy });
    return stored;
  }

  function requireHuman(approver) {
    const who = actorOf(approver);
    if (!who || who.kind !== 'human' || !isNonEmptyString(who.id)) {
      throw new GovernorError('approver_not_human', 'Only a human identity supplied by the application can decide on a proposal; a model never can.');
    }
    if (rules.approvers && !rules.approvers.includes(who.id)) throw new GovernorError('approver_not_allowed', 'This person is not an approver in the governor policy.');
    return who;
  }

  async function decide(id, { approver, organisationId, note } = {}, status) {
    const who = requireHuman(approver);
    if (!isNonEmptyString(organisationId)) throw new GovernorError('organisation_required', 'A decision needs its organisationId.');
    const proposal = await store.getProposal(organisationId, id);
    if (!proposal) throw new GovernorError('not_found', 'Proposal not found.');
    if (proposal.status !== 'pending_approval') throw new GovernorError('not_pending', `Proposal is ${proposal.status}, not pending approval.`);
    if (status === 'approved') {
      if (proposal.proposedBy?.kind === 'human' && proposal.proposedBy.id === who.id) throw new GovernorError('self_approval', 'A person cannot approve their own proposal.');
      if ((await haltState(organisationId)).halted) throw new GovernorError(REASONS.HALTED, 'The governor is halted.');
      if (protectedRulesTouched(rules, proposal).length) throw new GovernorError(REASONS.PROTECTED, 'The proposal touches a protected scope.');
    }
    const updated = await store.transitionProposal(organisationId, id, 'pending_approval', { status, approver: who, decidedAt: iso(), note: note == null ? null : String(note).slice(0, 2000) });
    if (!updated) throw new GovernorError('not_pending', 'Proposal is no longer pending approval.');
    await audit({ action: status === 'approved' ? 'approve' : 'decline', organisationId, proposalId: id, decision: status, actor: who });
    return updated;
  }

  async function authorizeSpend(input = {}) {
    const organisationId = assertSingleOrganisation(input.organisationId);
    if (!isNonEmptyString(input.id)) throw new GovernorError('invalid_spend', 'A spend needs a stable id (idempotency).');
    if (!isNonEmptyString(input.agentId)) throw new GovernorError('invalid_spend', 'A spend needs its agentId.');
    if (typeof input.cost !== 'number' || !Number.isFinite(input.cost) || input.cost < 0) throw new GovernorError('invalid_spend', 'cost must be a finite number >= 0.');
    const limits = { perCycle: rules.budgets.perCycle, perAgent: rules.budgets.perAgent, perOrganisation: rules.budgets.perOrganisation, since: now() - rules.budgets.periodMs };
    if ((await haltState(organisationId)).halted) {
      await audit({ action: 'spend_refused', organisationId, decision: 'refused', reasons: [REASONS.HALTED], spendId: input.id });
      return { allowed: false, reasons: [REASONS.HALTED], totals: null, limits };
    }
    const entry = { id: input.id, organisationId, agentId: input.agentId, cycleId: input.cycleId ?? null, cost: input.cost, at: now() };
    const result = await store.reserveSpend(entry, limits);
    const reasons = result.reserved ? [] : [REASONS.BUDGET];
    if (result.created || !result.reserved) await audit({ action: result.reserved ? 'spend' : 'spend_refused', organisationId, decision: result.reserved ? 'allowed' : 'refused', reasons, spendId: input.id, cost: input.cost });
    return { allowed: result.reserved, reasons, totals: result.totals, limits };
  }

  async function setHalt(halted, { by, reason, organisationId } = {}) {
    const who = actorOf(by);
    if (!who || !isNonEmptyString(who.id)) throw new GovernorError('actor_required', 'Say who pulls or releases the kill switch.');
    if (!halted && who.kind !== 'human') throw new GovernorError('approver_not_human', 'Only a human can release the kill switch.');
    const scope = organisationId == null ? GLOBAL : assertSingleOrganisation(organisationId);
    const value = { halted, by: who, reason: reason == null ? null : String(reason).slice(0, 2000), at: iso() };
    await store.setControl(`halt:${scope}`, value);
    await audit({ action: halted ? 'halt' : 'resume', organisationId: scope === GLOBAL ? null : scope, decision: halted ? 'halted' : 'running', actor: who });
    return value;
  }

  async function assertReady({ organisationId } = {}) {
    let state;
    try { state = await haltState(organisationId); } catch (error) {
      throw new GovernorError('governor_unavailable', `Governor unavailable: its store cannot be read (${error.message}).`);
    }
    if (state.halted) throw new GovernorError(REASONS.HALTED, 'The governor kill switch is on: reflective operations are stopped.');
    return true;
  }

  const governor = Object.freeze({
    getPolicy: () => copy(rules),
    evaluatePolicy,
    approveProposal: (id, options) => decide(id, options, 'approved'),
    declineProposal: (id, options) => decide(id, options, 'declined'),
    getProposal: (organisationId, id) => store.getProposal(organisationId, id),
    listProposals: (filter = {}) => { assertSingleOrganisation(filter.organisationId); return store.listProposals(filter); },
    listAudit: (filter = {}) => store.listAudit(filter),
    authorizeSpend,
    assertSingleOrganisation,
    halt: (options) => setHalt(true, options),
    resume: (options) => setHalt(false, options),
    isHalted: async (organisationId) => (await haltState(organisationId)).halted,
    assertReady
  });
  genuine.add(governor);
  return governor;
}

/**
 * Bootstrap check (40): call before any reflective write. Throws a
 * GovernorError when the governor is absent, not built by createGovernor, its
 * store is unreachable, or its kill switch is on.
 */
async function assertGovernorReady(governor, options = {}) {
  if (governor == null) throw new GovernorError('governor_missing', 'No governor: reflective operations refuse to start without one (createGovernor(policy)).');
  if (!genuine.has(governor)) throw new GovernorError('governor_invalid', 'This object is not a governor built by createGovernor().');
  return governor.assertReady(options);
}

const isGovernor = (value) => genuine.has(value);

module.exports = { createGovernor, assertGovernorReady, isGovernor, STATUSES, REASONS };
