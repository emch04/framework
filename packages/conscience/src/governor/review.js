'use strict';
/*
 * Morning review (proposition 08), rejection signals and the approval
 * invariant (proposition 20). The report is data: ids, codes, numbers and the
 * objects the proposer supplied. It contains no generated sentence, so any
 * interface can display it in its own words and languages. Same store, same
 * period, same answer.
 */
const { GovernorError, fingerprintOf, copy, isNonEmptyString } = require('./util');
const { assess, liveApprovals, checkApprovals } = require('./approvals');

const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);
const CODE = /^[a-z][a-z0-9_.-]{1,60}$/;
const REPORT_SCHEMA = 'morning-report/1';

function timeOf(value, label) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new GovernorError('invalid_period', `${label} must be a date.`);
  return ms;
}

const targetOf = (proposal) => ({ kind: proposal.target?.kind ?? null, id: proposal.target?.id ?? null, version: proposal.target?.version ?? null });
const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function createReview(ctx) {
  const { rules, store, now, iso, audit, assertSingleOrganisation, haltState } = ctx;
  const bounded = (limit) => Math.min(Math.max(Number(limit) || 100, 1), 1000);

  /* ---- findings received from the reflection engine ---- */

  async function recordFinding(input = {}) {
    if (!input || typeof input !== 'object') throw new GovernorError('invalid_finding', 'A finding must be an object.');
    const organisationId = assertSingleOrganisation(input.organisationId);
    if ((await haltState(organisationId)).halted) throw new GovernorError('governor_halted', 'The governor is halted: findings are not accepted.');
    if (typeof input.code !== 'string' || !CODE.test(input.code)) throw new GovernorError('invalid_finding', 'code must be a short machine code such as "calibration_gap".');
    if (!SEVERITIES.includes(input.severity)) throw new GovernorError('invalid_finding', `severity must be one of ${SEVERITIES.join(', ')}.`);
    const subject = input.subject && typeof input.subject === 'object' ? { kind: String(input.subject.kind ?? ''), id: String(input.subject.id ?? '') } : null;
    if (!subject || !subject.kind || !subject.id) throw new GovernorError('invalid_finding', 'subject { kind, id } is required.');
    const list = (value) => (Array.isArray(value) ? value.map(String) : []);
    const number = (value, label, min, max) => {
      if (value == null) return null;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new GovernorError('invalid_finding', `${label} is out of range.`);
      return value;
    };
    const recordedBy = input.recordedBy && typeof input.recordedBy === 'object' ? { kind: String(input.recordedBy.kind ?? ''), id: String(input.recordedBy.id ?? '') } : null;
    if (!recordedBy?.id) throw new GovernorError('actor_required', 'Say who reports the finding.');
    const content = {
      organisationId, runId: input.runId ?? null, code: input.code, severity: input.severity, subject, decisionIds: list(input.decisionIds),
      evidenceRefs: list(input.evidenceRefs), sampleSize: number(input.sampleSize, 'sampleSize', 0, Number.MAX_SAFE_INTEGER),
      confidence: number(input.confidence, 'confidence', 0, 1), metrics: copy(input.metrics) ?? null, recordedBy
    };
    const id = isNonEmptyString(input.id) ? input.id : `finding_${fingerprintOf(content).slice(0, 32)}`;
    const { record, created } = await store.putFinding({ id, ...content, receivedAt: iso() });
    if (created) await audit({ action: 'finding', organisationId, decision: 'received', reasons: [input.code], findingId: id, actor: recordedBy });
    return record;
  }

  const listFindings = (filter = {}) => {
    const organisationId = assertSingleOrganisation(filter.organisationId);
    return store.listFindings({ organisationId, since: filter.since == null ? undefined : new Date(timeOf(filter.since, 'since')).toISOString(), limit: filter.limit });
  };

  /* ---- rejection signals, readable by the evaluation and experiment phases ---- */

  function signalOf(proposal) {
    const human = proposal.status === 'declined';
    return {
      proposalId: proposal.id, organisationId: proposal.organisationId, origin: human ? 'human' : 'governor',
      reasonCodes: human ? [proposal.declineReason ?? 'other'] : [...proposal.reasons],
      target: targetOf(proposal), risk: proposal.risk ?? null, scopes: [...(proposal.scopes ?? [])], rules: [...(proposal.rules ?? [])],
      proposedBy: proposal.proposedBy, decidedBy: human ? proposal.approver : null, at: proposal.decidedAt ?? proposal.createdAt
    };
  }

  async function listRejectionSignals(filter = {}) {
    const organisationId = assertSingleOrganisation(filter.organisationId);
    const statuses = filter.origin === 'human' ? ['declined'] : filter.origin === 'governor' ? ['rejected'] : ['declined', 'rejected'];
    const proposals = await store.listProposals({
      organisationId, statuses, limit: filter.limit == null ? 1000 : bounded(filter.limit),
      since: filter.since == null ? undefined : new Date(timeOf(filter.since, 'since')).toISOString()
    });
    const signals = proposals.map(signalOf)
      .filter((s) => filter.reasonCode == null || s.reasonCodes.includes(filter.reasonCode))
      .filter((s) => filter.targetKind == null || s.target.kind === filter.targetKind);
    return signals.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.proposalId < b.proposalId ? -1 : 1)).slice(0, bounded(filter.limit));
  }

  /* ---- the morning report ---- */

  async function morningReport(input = {}) {
    const organisationId = assertSingleOrganisation(input.organisationId);
    const untilMs = input.until == null ? now() : timeOf(input.until, 'until');
    const sinceMs = timeOf(input.since, 'since');
    if (sinceMs > untilMs) throw new GovernorError('invalid_period', 'since must not be after until.');
    const since = new Date(sinceMs).toISOString(); const until = new Date(untilMs).toISOString();
    const limit = bounded(input.limit);

    const [findings, pending, approved, signals, objects, rollbackEntries] = await Promise.all([
      store.listFindings({ organisationId, since, until, limit }),
      store.listProposals({ organisationId, status: 'pending_approval', limit: 1000 }),
      store.listProposals({ organisationId, status: 'approved', limit: 1000 }),
      listRejectionSignals({ organisationId, since, limit }),
      store.listObjects({ organisationId, hasCandidate: true, limit: 1000 }),
      store.listAudit({ organisationId, actions: ['rollback', 'emergency_revert'], since, limit })
    ]);

    const findingItems = findings.filter((f) => f.receivedAt <= until).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : byIdAsc(a, b)));
    const bySeverity = Object.fromEntries(SEVERITIES.map((level) => [level, findingItems.filter((f) => f.severity === level).length]));

    const pendingItems = pending.filter((p) => p.createdAt <= until).map((p) => {
      const assessment = assess(rules, p);
      const live = liveApprovals(p, untilMs);
      return {
        id: p.id, target: targetOf(p), risk: assessment.risk, requiredApprovals: assessment.requiredApprovals,
        approvalsValid: live.length, approvedBy: live.map((a) => ({ id: a.approver.id, role: a.role ?? null, at: a.at, expiresAt: a.expiresAt })),
        allowedRoles: assessment.allowedRoles, scopes: [...(p.scopes ?? [])], proposedBy: p.proposedBy, owner: p.owner ?? null, createdAt: p.createdAt,
        hasJustification: p.justification != null && p.justification !== '',
        hasTests: p.tests != null, tests: copy(p.tests), hasReplay: p.replay != null,
        hasRollbackPlan: p.rollback != null, rollbackPlan: copy(p.rollback)
      };
    }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : byIdAsc(a, b)));

    const awaiting = approved.filter((p) => !p.staged).map((p) => {
      const check = checkApprovals(rules, p, untilMs);
      const live = liveApprovals(p, untilMs);
      const expiresAt = (p.approvals ?? []).map((a) => a.expiresAt).sort()[0] ?? null;
      return { id: p.id, target: targetOf(p), risk: assess(rules, p).risk, approvedAt: p.decidedAt, expiresAt, valid: check.ok, expired: !check.ok && check.code === 'approval_expired', approvalsValid: live.length };
    }).sort(byIdAsc);

    const rollouts = objects.map((o) => ({
      kind: o.kind, id: o.id, stableVersion: o.stable, candidateVersion: o.candidate, percentage: o.rollout?.percentage ?? 0, cohorts: [...(o.rollout?.cohorts ?? [])],
      startedAt: o.rollout?.startedAt ?? null, updatedAt: o.rollout?.updatedAt ?? null
    }));
    for (const rollout of rollouts) {
      const version = await store.getVersion(organisationId, rollout.kind, rollout.id, rollout.candidateVersion);
      rollout.proposalId = version?.proposalId ?? null;
    }
    rollouts.sort((a, b) => (`${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1));

    const rollbacks = rollbackEntries.filter((e) => e.at <= until).map((e) => ({
      at: e.at, kind: e.objectKind, id: e.objectId, fromVersion: e.fromVersion, toVersion: e.toVersion, mode: e.decision,
      emergency: e.action === 'emergency_revert', reason: e.reason ?? null, actor: e.actor
    })).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    const rejections = signals.filter((s) => s.at <= until);

    return {
      schema: REPORT_SCHEMA, organisationId, policyVersion: rules.version, since, until, halted: (await haltState(organisationId)).halted,
      findings: { total: findingItems.length, bySeverity, items: findingItems },
      pendingProposals: pendingItems, approvedAwaitingStage: awaiting, rollouts, rejections, rollbacks,
      counts: {
        findings: findingItems.length, pending: pendingItems.length, pendingHighRisk: pendingItems.filter((p) => p.risk === 'high' || p.risk === 'critical').length,
        approvedAwaitingStage: awaiting.length, rollouts: rollouts.length, rejections: rejections.length,
        humanRejections: rejections.filter((s) => s.origin === 'human').length, rollbacks: rollbacks.length
      }
    };
  }

  /* ---- the invariant: nothing is applied because a model approved it ---- */

  async function verifyApprovalInvariant(input = {}) {
    const organisationId = assertSingleOrganisation(input.organisationId);
    const violations = [];
    const proposals = await store.listProposals({ organisationId, statuses: ['approved', 'expired'], limit: 1000 });
    const byId = new Map(proposals.map((p) => [p.id, p]));
    for (const proposal of proposals) {
      const check = checkApprovals(rules, proposal, 0);
      if (!check.ok && check.code !== 'approval_expired') violations.push({ type: 'proposal', proposalId: proposal.id, code: check.code });
    }
    let versions = 0;
    for (const object of await store.listObjects({ organisationId, limit: 1000 })) {
      for (const version of await store.listVersions({ organisationId, kind: object.kind, id: object.id, limit: 1000 })) {
        versions += 1;
        if (version.source === 'baseline') {
          if (!['human', 'system'].includes(version.createdBy?.kind)) violations.push({ type: 'version', versionId: version.versionId, kind: object.kind, id: object.id, code: 'baseline_not_human_or_system' });
          continue;
        }
        const proposal = byId.get(version.proposalId) ?? await store.getProposal(organisationId, version.proposalId);
        const check = proposal ? checkApprovals(rules, proposal, 0) : { ok: false, code: 'proposal_missing' };
        if (!proposal || proposal.status === 'declined' || proposal.status === 'rejected' || proposal.status === 'pending_approval' || (!check.ok && check.code !== 'approval_expired')) {
          violations.push({ type: 'version', versionId: version.versionId, kind: object.kind, id: object.id, proposalId: version.proposalId ?? null, code: proposal ? (check.code ?? `status_${proposal.status}`) : 'proposal_missing' });
        }
      }
    }
    return { ok: violations.length === 0, checked: { proposals: proposals.length, versions }, violations };
  }

  return { recordFinding, listFindings, listRejectionSignals, morningReport, verifyApprovalInvariant };
}

module.exports = { createReview, SEVERITIES, REPORT_SCHEMA };
