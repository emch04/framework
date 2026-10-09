'use strict';
/*
 * Reversible changes (proposition 06). A managed object (instructions,
 * threshold, tool description, routing rule) has a stable version and at most
 * one candidate. A candidate is created only from a proposal that a human
 * approved, starts at 0 % exposure, grows by decision of a human, and can be
 * rolled back at any moment. Every step is audited with the version before and
 * after. Nothing here calls a model.
 */
const { GovernorError, fingerprintOf, copy, isNonEmptyString } = require('./util');
const { protectedRulesTouched } = require('./policy');
const { checkApprovals } = require('./approvals');
const { normalizeExposure, servesCandidate, seedOf, flagKeyOf, toFlagRules } = require('./rollout');

const MAX_RETRIES = 6;
const ACTOR_KINDS_STAGE = ['human', 'system', 'engine'];
const ACTOR_KINDS_BASELINE = ['human', 'system'];

function createChanges(ctx) {
  const { rules, store, now, iso, audit, haltState, assertSingleOrganisation, normalizeProposal } = ctx;

  const actorOf = (actor, kinds, code = 'actor_not_allowed') => {
    const who = actor && typeof actor === 'object' ? { kind: String(actor.kind ?? ''), id: String(actor.id ?? '') } : null;
    if (!who || !isNonEmptyString(who.id)) throw new GovernorError('actor_required', 'Say who acts.');
    if (kinds && !kinds.includes(who.kind)) throw new GovernorError(code, `This action is for: ${kinds.join(', ')}.`);
    return who;
  };

  async function assertRunning(organisationId) {
    if ((await haltState(organisationId)).halted) throw new GovernorError('governor_halted', 'The governor is halted: no change may start or grow.');
  }

  function coordinates(input) {
    const organisationId = assertSingleOrganisation(input.organisationId);
    if (!isNonEmptyString(input.kind) || !isNonEmptyString(input.id)) throw new GovernorError('invalid_object', 'An object needs its kind and its id.');
    if (!rules.permissions.modifiable.includes(input.kind)) throw new GovernorError('not_allowlisted', `"${input.kind}" is not a modifiable kind.`);
    return { organisationId, kind: input.kind, id: input.id };
  }

  async function loadObject({ organisationId, kind, id }) {
    const state = await store.getObject(organisationId, kind, id);
    if (!state) throw new GovernorError('not_found', 'Object not registered.');
    return state;
  }

  /* Compare-and-set loop on the object state: concurrent changes never overwrite each other. */
  async function mutate(at, fn) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const state = await loadObject(at);
      const result = await fn(state);
      if (result === null) return { state, changed: false };
      const next = { ...result.next, revision: state.revision + 1, updatedAt: iso() };
      const stored = await store.updateObject(at.organisationId, at.kind, at.id, state.revision, next);
      if (stored) return { state: stored, before: state, changed: true, extra: result.extra };
    }
    throw new GovernorError('change_conflict', 'The object kept changing: try again.');
  }

  const sameContent = (version, content) => version.fingerprint === fingerprintOf(content);

  async function registerObject(input = {}) {
    const at = coordinates(input);
    const who = actorOf(input.by, ACTOR_KINDS_BASELINE);
    await assertRunning(at.organisationId);
    if (input.content === undefined || input.content === null) throw new GovernorError('invalid_object', 'A baseline needs its content.');
    if (protectedRulesTouched(rules, { target: { kind: at.kind, id: at.id }, change: input.content }).length) throw new GovernorError('protected_scope', 'A protected scope cannot be versioned here.');
    const content = copy(input.content);
    const version = { ...at, versionId: 'v1', number: 1, content, fingerprint: fingerprintOf(content), parent: null, source: 'baseline', proposalId: null, createdAt: iso(), createdBy: who };
    const state = { ...at, revision: 1, stable: 'v1', stableHistory: ['v1'], candidate: null, rollout: null, nextNumber: 2, createdAt: version.createdAt, updatedAt: version.createdAt };
    const existing = await store.getObject(at.organisationId, at.kind, at.id);
    if (existing) {
      const current = await store.getVersion(at.organisationId, at.kind, at.id, 'v1');
      if (current && sameContent(current, content)) return { object: existing, version: current, created: false };
      throw new GovernorError('object_exists', 'This object is already registered with another baseline.');
    }
    const putVersion = await store.putVersion(version);
    const created = await store.createObject(state);
    if (!created.created) throw new GovernorError('object_exists', 'This object is already registered.');
    await audit({ action: 'register', organisationId: at.organisationId, decision: 'registered', objectKind: at.kind, objectId: at.id, fromVersion: null, toVersion: 'v1', actor: who });
    return { object: created.record, version: putVersion.record, created: true };
  }

  async function stageChange(proposalId, input = {}) {
    const who = actorOf(input.by, ACTOR_KINDS_STAGE);
    const organisationId = assertSingleOrganisation(input.organisationId);
    await assertRunning(organisationId);
    const proposal = await store.getProposal(organisationId, proposalId);
    if (!proposal) throw new GovernorError('not_found', 'Proposal not found.');
    if (normalizeProposal({ ...proposal, risk: proposal.declaredRisk ?? null }).fingerprint !== proposal.fingerprint) throw new GovernorError('proposal_tampered', 'The stored proposal no longer matches its fingerprint.');
    if (proposal.status === 'expired') throw new GovernorError('approval_expired', 'The approval of this proposal has expired.');
    if (proposal.status !== 'approved') throw new GovernorError('not_approved', `Proposal is ${proposal.status}: only a proposal approved by a human can be staged.`);
    if (protectedRulesTouched(rules, proposal).length) throw new GovernorError('protected_scope', 'The proposal touches a protected scope: it can never be applied.');
    if (!rules.permissions.modifiable.includes(proposal.target.kind)) throw new GovernorError('not_allowlisted', 'The target kind is no longer allowed.');
    if (new Set([proposal.organisationId, ...(proposal.organisationIds ?? []), ...(proposal.target.organisationId ? [proposal.target.organisationId] : [])]).size > 1) {
      throw new GovernorError('cross_organisation', 'The proposal touches another organisation.');
    }
    const at = { organisationId, kind: proposal.target.kind, id: proposal.target.id };

    const state = await loadObject(at);
    const staged = state.candidate ? await store.getVersion(organisationId, at.kind, at.id, state.candidate) : null;
    if (staged?.proposalId === proposal.id) return { object: state, version: staged, created: false };
    if (proposal.staged) throw new GovernorError('already_staged', 'This proposal was already staged: propose again.');

    const check = checkApprovals(rules, proposal, now());
    if (!check.ok) {
      if (check.code === 'approval_expired') {
        const expired = await store.transitionProposal(organisationId, proposal.id, 'approved', { status: 'expired', decidedAt: iso() });
        if (expired) await audit({ action: 'expire', organisationId, proposalId: proposal.id, decision: 'expired', reasons: ['approval_expired'], actor: who });
      }
      throw new GovernorError(check.code, check.reason);
    }
    if (state.candidate) throw new GovernorError('candidate_exists', 'This object already has a candidate: promote or roll it back first.');
    if (proposal.target.version != null && proposal.target.version !== state.stable) throw new GovernorError('stale_base', `The proposal targets ${proposal.target.version}, the stable version is ${state.stable}.`);

    const number = state.nextNumber;
    const versionId = `v${number}`;
    const content = copy(proposal.change);
    const record = {
      ...at, versionId, number, content, fingerprint: fingerprintOf(content), parent: state.stable, source: 'proposal',
      proposalId: proposal.id, createdAt: iso(), createdBy: who, approvedBy: proposal.approvals.map((a) => ({ id: a.approver.id, role: a.role ?? null, at: a.at }))
    };
    const put = await store.putVersion(record);
    if (!put.created && put.record.proposalId !== proposal.id) throw new GovernorError('change_conflict', 'Another change is being staged on this object.');
    const outcome = await mutate(at, (current) => {
      if (current.candidate) {
        if (current.candidate === versionId) return null;
        throw new GovernorError('candidate_exists', 'This object already has a candidate.');
      }
      if (current.stable !== state.stable) throw new GovernorError('stale_base', 'The stable version changed while staging.');
      return { next: { ...current, candidate: versionId, rollout: { percentage: 0, cohorts: [], startedAt: iso(), updatedAt: iso(), updatedBy: who }, nextNumber: Math.max(current.nextNumber, number + 1) } };
    });
    await store.transitionProposal(organisationId, proposal.id, 'approved', { staged: { versionId, at: iso(), by: who } });
    if (outcome.changed) {
      await audit({
        action: 'stage', organisationId, proposalId: proposal.id, decision: 'staged', objectKind: at.kind, objectId: at.id,
        fromVersion: state.stable, toVersion: versionId, rolloutBefore: null, rolloutAfter: { percentage: 0, cohorts: [] }, actor: who,
        approvedBy: record.approvedBy
      });
    }
    return { object: outcome.state, version: put.record, created: outcome.changed };
  }

  async function deployChange(input = {}) {
    const at = coordinates(input);
    const who = actorOf(input.by, ['human'], 'approver_not_human');
    if (rules.approvers && !rules.approvers.includes(who.id)) throw new GovernorError('approver_not_allowed', 'This person is not an approver in the governor policy.');
    await assertRunning(at.organisationId);
    const outcome = await mutate(at, (state) => {
      if (!state.candidate) throw new GovernorError('no_candidate', 'This object has no candidate to deploy.');
      const exposure = normalizeExposure(input, state.rollout);
      return { next: { ...state, rollout: { ...exposure, startedAt: state.rollout?.startedAt ?? iso(), updatedAt: iso(), updatedBy: who } } };
    });
    await audit({
      action: 'deploy', organisationId: at.organisationId, decision: 'deployed', objectKind: at.kind, objectId: at.id,
      fromVersion: outcome.before.stable, toVersion: outcome.state.candidate, rolloutBefore: outcome.before.rollout && { percentage: outcome.before.rollout.percentage, cohorts: outcome.before.rollout.cohorts },
      rolloutAfter: { percentage: outcome.state.rollout.percentage, cohorts: outcome.state.rollout.cohorts }, actor: who
    });
    return outcome.state;
  }

  async function promoteChange(input = {}) {
    const at = coordinates(input);
    const who = actorOf(input.by, ['human'], 'approver_not_human');
    if (rules.approvers && !rules.approvers.includes(who.id)) throw new GovernorError('approver_not_allowed', 'This person is not an approver in the governor policy.');
    await assertRunning(at.organisationId);
    const outcome = await mutate(at, (state) => {
      if (!state.candidate) throw new GovernorError('no_candidate', 'This object has no candidate to promote.');
      if (state.rollout?.percentage !== 100 || state.rollout.cohorts.length) throw new GovernorError('rollout_incomplete', 'Deploy the candidate to 100 % of everyone before promoting it.');
      return { next: { ...state, stable: state.candidate, stableHistory: [...state.stableHistory, state.candidate], candidate: null, rollout: null } };
    });
    await audit({ action: 'promote', organisationId: at.organisationId, decision: 'promoted', objectKind: at.kind, objectId: at.id, fromVersion: outcome.before.stable, toVersion: outcome.state.stable, rolloutBefore: { percentage: 100, cohorts: [] }, rolloutAfter: null, actor: who });
    return outcome.state;
  }

  /* Back to the previous state: discards the candidate, or restores the version that was stable before the last promotion. */
  async function rollback(at, who, reason, action) {
    const outcome = await mutate(at, (state) => {
      if (state.candidate) return { next: { ...state, candidate: null, rollout: null }, extra: { mode: 'candidate_discarded', discarded: state.candidate, restored: state.stable } };
      if (state.stableHistory.length < 2) throw new GovernorError('nothing_to_rollback', 'There is no earlier version to return to.');
      const history = state.stableHistory.slice(0, -1);
      return { next: { ...state, stable: history[history.length - 1], stableHistory: history }, extra: { mode: 'stable_restored', discarded: state.stable, restored: history[history.length - 1] } };
    });
    const { mode, discarded, restored } = outcome.extra;
    await audit({
      action, organisationId: at.organisationId, decision: mode, objectKind: at.kind, objectId: at.id, fromVersion: discarded, toVersion: restored,
      rolloutBefore: outcome.before.rollout && { percentage: outcome.before.rollout.percentage, cohorts: outcome.before.rollout.cohorts }, rolloutAfter: null,
      reason: reason == null ? null : String(reason).slice(0, 500), actor: who
    });
    return { object: outcome.state, mode, discardedVersion: discarded, restoredVersion: restored };
  }

  /** Always possible, even while halted, by any identified actor: going back is the safe direction. */
  async function rollbackChange(input = {}) {
    const at = coordinates(input);
    return rollback(at, actorOf(input.by), input.reason, 'rollback');
  }

  /** Emergency stop: every candidate of the scope goes back to its stable version. Never throws; returns what failed. */
  async function revertAllCandidates({ organisationId, by, reason }) {
    const reverted = []; const failures = []; const skip = new Set();
    for (;;) {
      const batch = (await store.listObjects({ organisationId: organisationId ?? undefined, hasCandidate: true, limit: 1000 }))
        .filter((o) => !skip.has(`${o.organisationId}\u0000${o.kind}\u0000${o.id}`));
      if (!batch.length) break;
      for (const object of batch) {
        const at = { organisationId: object.organisationId, kind: object.kind, id: object.id };
        try {
          const result = await rollback(at, by, reason, 'emergency_revert');
          reverted.push({ ...at, discardedVersion: result.discardedVersion, restoredVersion: result.restoredVersion });
        } catch (error) {
          failures.push({ ...at, code: error.code ?? 'error' });
          skip.add(`${at.organisationId}\u0000${at.kind}\u0000${at.id}`);
        }
      }
    }
    return { reverted, failures };
  }

  /** Which version does this caller get? Halted, no candidate, or outside the rollout: the stable one. */
  async function resolveVersion(input = {}) {
    const at = coordinates(input);
    const state = await loadObject(at);
    const pick = async (versionId, source, reason) => {
      const version = await store.getVersion(at.organisationId, at.kind, at.id, versionId);
      return { versionId, source, reason, content: version.content, number: version.number };
    };
    if (!state.candidate) return pick(state.stable, 'stable', 'no_candidate');
    if ((await haltState(at.organisationId)).halted) return pick(state.stable, 'stable', 'halted');
    const context = { targetingKey: input.targetingKey, attributes: input.attributes };
    let served = false;
    if (ctx.flags) {
      try { served = (await ctx.flags.resolveBoolean(flagKeyOf(at.organisationId, at.kind, at.id), false, context))?.value === true; } catch (_error) { served = false; }
    } else served = servesCandidate(state.rollout, seedOf(at.organisationId, at.kind, at.id, state.candidate), context);
    return served ? pick(state.candidate, 'candidate', 'in_rollout') : pick(state.stable, 'stable', 'not_in_rollout');
  }

  const statusOf = (state, versionId) => (versionId === state.stable ? 'stable' : versionId === state.candidate ? 'candidate' : state.stableHistory.includes(versionId) ? 'previous' : 'discarded');

  async function listVersions(input = {}) {
    const at = coordinates(input);
    const state = await loadObject(at);
    const versions = await store.listVersions({ ...at, limit: input.limit });
    return versions.map((version) => ({ ...version, status: statusOf(state, version.versionId) }));
  }

  async function getObject(input = {}) {
    const at = coordinates(input);
    return store.getObject(at.organisationId, at.kind, at.id);
  }

  async function listObjects(input = {}) {
    const organisationId = assertSingleOrganisation(input.organisationId);
    return store.listObjects({ organisationId, kind: input.kind, hasCandidate: input.hasCandidate === true, limit: input.limit });
  }

  async function getChangeHistory(input = {}) {
    const at = coordinates(input);
    return store.listAudit({ organisationId: at.organisationId, objectKind: at.kind, objectId: at.id, limit: input.limit });
  }

  async function exportFlagRules(input = {}) {
    const organisationId = assertSingleOrganisation(input.organisationId);
    return toFlagRules(await store.listObjects({ organisationId, hasCandidate: true, limit: 1000 }));
  }

  return { registerObject, stageChange, deployChange, promoteChange, rollbackChange, revertAllCandidates, resolveVersion, listVersions, getObject, listObjects, getChangeHistory, exportFlagRules };
}

module.exports = { createChanges };
